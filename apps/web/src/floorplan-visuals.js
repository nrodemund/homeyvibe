import { HISTORY_BUCKET_MS, HISTORY_WINDOW_MS, NUMERIC_DISPLAYS } from '../../../packages/shared/src/floorplan.js';
import { formatValue } from './controls.js';

const clamp = (n) => Math.max(0, Math.min(1, n));
const cacheKey = ([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`;

/** Candidate capabilities for a marker. Prefer primary readings over diagnostics. */
export function displayCapabilities(device, mode) {
  const eligible = (cap) => {
    if (NUMERIC_DISPLAYS.includes(mode)) return cap.type === 'numeric';
    if (mode === 'status') return cap.type === 'binary';
    return ['binary', 'numeric', 'enum', 'text'].includes(cap.type);
  };
  return device.capabilities.filter((cap) => cap.readable && eligible(cap)).sort((a, b) =>
    Number(a.category === 'diagnostic') - Number(b.category === 'diagnostic'));
}

/** Default scale for a sensor, adjustable for each marker. */
export function displayRange(display, cap) {
  const temperature = cap?.property === 'temperature' && !cap?.unit?.includes('F');
  const fallback = temperature ? [15, 30] : [0, 100];
  const min = display.min ?? cap?.min ?? fallback[0];
  const max = display.max ?? cap?.max ?? fallback[1];
  return max > min ? [min, max] : display.max !== undefined && display.min === undefined
    ? [max - 10, max] : [min, min + 10];
}

/** The selected reading and its visual scale. Missing and offline state remain distinguishable. */
export function markerReading(device, display) {
  const capabilities = displayCapabilities(device, display.mode);
  const cap = display.property ? capabilities.find((c) => c.property === display.property) : capabilities[0];
  const value = cap ? device.state[cap.property] : undefined;
  const [min, max] = displayRange(display, cap);
  const fraction = Number.isFinite(value) ? clamp((value - min) / (max - min)) : null;
  const active = display.mode === 'threshold' && fraction !== null ? value >= (display.threshold ?? (min + max) / 2)
    : display.mode === 'status' && cap && value !== undefined && value !== null ? value === cap.valueOn : null;
  return { cap, value, fraction, active, text: cap ? formatValue(cap, value) : '–' };
}

/** Merge history snapshots with live values, keeping the latest report in each five-minute interval. */
export function mergeHistory(groups, now = Date.now()) {
  const buckets = new Map();
  for (const [time, value] of groups.flat()) {
    if (time < now - HISTORY_WINDOW_MS || !Number.isFinite(value)) continue;
    const key = Math.floor(time / HISTORY_BUCKET_MS);
    if (!buckets.has(key) || time >= buckets.get(key)[0]) buckets.set(key, [time, value]);
  }
  return [...buckets.values()].sort(([a], [b]) => a - b);
}

/** Map history to the chart. The last 24 hours and actual reading timestamps determine x. */
export function chartPoints(points, display, now, width, height) {
  if (!points.length) return [];
  const values = points.map(([, value]) => value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const padding = Math.max((hi - lo) / 8, 0.1);
  const min = display.min ?? lo - padding;
  const max = display.max ?? hi + padding;
  return points.map(([time, value]) => [
    clamp(1 - (now - time) / HISTORY_WINDOW_MS) * width,
    (1 - clamp((value - min) / Math.max(0.001, max - min))) * height,
  ]);
}

/** Merge exactly shared room edges and map each opening to the direction of the first edge. */
export function roomWalls(rooms) {
  const walls = new Map();
  for (const room of rooms) {
    for (const [edge, from] of room.points.entries()) {
      const to = room.points[(edge + 1) % room.points.length];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      if (length < 0.001) continue;
      const key = [cacheKey(from), cacheKey(to)].sort().join('|');
      const wall = walls.get(key) ?? { from, to, length, rooms: [], openings: [] };
      const reversed = cacheKey(from) !== cacheKey(wall.from);
      wall.rooms.push({ room, reversed });
      for (const opening of room.openings ?? []) {
        if (opening.edge !== edge) continue;
        const offset = reversed ? Math.max(0, length - opening.offset - opening.width) : opening.offset;
        const normalized = { ...opening, offset };
        if (!wall.openings.some((other) => ['offset', 'width', 'bottom', 'height'].every((k) => Math.abs(other[k] - normalized[k]) < 0.002))) {
          wall.openings.push(normalized);
        }
      }
      walls.set(key, wall);
    }
  }
  return [...walls.values()];
}

/** Rectangular parts of a wall after doors and windows are cut out. */
export function wallPieces(length, height, openings) {
  const cuts = openings.map((o) => ({
    from: Math.max(0, o.offset), to: Math.min(length, o.offset + o.width),
    bottom: o.bottom, top: Math.min(height, o.bottom + o.height),
  })).filter((o) => o.from < o.to && o.bottom < o.top);
  const x = [...new Set([0, length, ...cuts.flatMap((o) => [o.from, o.to])])].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 1; i < x.length; i++) {
    const from = x[i - 1];
    const to = x[i];
    if (to - from < 0.001) continue;
    let bottom = 0;
    for (const cut of cuts.filter((o) => o.from < to && o.to > from).sort((a, b) => a.bottom - b.bottom)) {
      if (cut.bottom - bottom >= 0.001) pieces.push({ from, to, bottom, top: cut.bottom });
      bottom = Math.max(bottom, cut.top);
    }
    if (height - bottom >= 0.001) pieces.push({ from, to, bottom, top: height });
  }
  return pieces;
}

/** Root loads the configured start page. An explicit All devices tab always goes there. */
export function pageIdForHash(hash, pages) {
  if (!hash) return pages.find((p) => p.startPage)?.id ?? null;
  const match = /^#\/page\/(.+)$/.exec(hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/** Fit nearby marker labels around their projected anchors so their controls stay clickable. */
export function arrangeMarkers(markers, width, height) {
  const placed = [];
  const fit = (value, limit) => Math.max(4, Math.min(value, Math.max(4, limit - 4)));
  const overlaps = (a, b) => a.left < b.left + b.width + 3 && b.left < a.left + a.width + 3 &&
    a.top < b.top + b.height + 3 && b.top < a.top + a.height + 3;
  return markers.map((marker) => {
    const { x, y, w, h } = marker;
    const offsetY = h + 6;
    const offsetX = w + 6;
    const candidates = [[0, 0], [0, -offsetY], [0, offsetY], [0, -2 * offsetY], [0, 2 * offsetY],
      [-offsetX, 0], [offsetX, 0], [-offsetX, -offsetY], [offsetX, -offsetY], [0, -3 * offsetY], [0, 3 * offsetY]];
    const positions = candidates.map(([dx, dy]) => ({
      left: fit(x - w / 2 + dx, width - w),
      top: fit(y - h / 2 + dy, height - h),
      width: w, height: h,
    }));
    const position = positions.find((candidate) => placed.every((other) => !overlaps(candidate, other))) ?? positions[0];
    placed.push(position);
    return [(x - position.left) / w, (y - position.top) / h];
  });
}
