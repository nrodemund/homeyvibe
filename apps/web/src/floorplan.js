// Floor plan geometry and device placement. Pure functions (no DOM, no three.js) so they can be unit-tested.
// Coordinates are meters seen from above: [x, z]; y is height above the floor.

import { deviceIcon, splitCapabilities, formatValue } from './controls.js';

export const ICONS = {
  light: '💡', switch: '🔘', cover: '🪟', climate: '🌡️', lock: '🔒', fan: '🌀', sensor: '📟', device: '📦',
};

/** Typical mounting height per kind of device, in meters. */
const DEFAULT_HEIGHT = { light: 2.1, cover: 1.5, sensor: 1.5, climate: 1.5, switch: 1.2, lock: 1.0, fan: 2.2, device: 1.0 };

export function defaultHeight(device) {
  return DEFAULT_HEIGHT[deviceIcon(device)] ?? 1;
}

export const snap = (value, step) => Math.round(value / step) * step;

export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

/** Area-weighted centroid; falls back to the average of the corners for degenerate shapes. */
export function centroid(points) {
  const a = polygonArea(points);
  if (Math.abs(a) < 1e-9) {
    const n = points.length;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    const f = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * f;
    cz += (z1 + z2) * f;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/** Ray casting point-in-polygon test. */
export function pointInPolygon([x, z], points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function roomAt(plan, x, z, floor = null) {
  return plan.rooms.find((r) => (floor === null || r.floor === floor) && pointInPolygon([x, z], r.points)) ?? null;
}

/** { minX, maxX, minZ, maxZ } around the given rooms, or a 6×6 m area when there are none. */
export function bounds(rooms) {
  if (!rooms.length) return { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };
  const xs = rooms.flatMap((r) => r.points.map((p) => p[0]));
  const zs = rooms.flatMap((r) => r.points.map((p) => p[1]));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** Distinct floors in the plan, lowest first; always at least [0]. */
export function floorsOf(plan) {
  const floors = [...new Set(plan.rooms.map((r) => r.floor ?? 0))].sort((a, b) => a - b);
  return floors.length ? floors : [0];
}

/** Edges of all rooms with shared walls listed once: [[x1, z1], [x2, z2]][] */
export function wallSegments(rooms) {
  const seen = new Set();
  const walls = [];
  const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  for (const room of rooms) {
    room.points.forEach((a, i) => {
      const b = room.points[(i + 1) % room.points.length];
      const k = [key(a), key(b)].sort().join('|');
      if (seen.has(k) || (a[0] === b[0] && a[1] === b[1])) return;
      seen.add(k);
      walls.push([a, b]);
    });
  }
  return walls;
}

/**
 * Where each device goes. Devices placed in the plan keep their position. Others are guessed:
 * into a room whose name appears in the device name (or in the page section listing it),
 * spread around the room's center; anything left over lines up just outside the plan.
 *
 * @param {object} plan floor plan
 * @param {object[]} devices devices to show
 * @param {Map<string,string>} [hints] deviceId -> extra text that may name a room (e.g. section title)
 * @returns {Map<string, { position: number[], roomId: string|null, placed: boolean }>}
 */
export function autoPlace(plan, devices, hints = new Map()) {
  const result = new Map();
  const placed = new Map(plan.devices.map((d) => [d.deviceId, d]));
  const perRoom = new Map();
  const leftovers = [];
  const rooms = [...plan.rooms].sort((a, b) => b.name.length - a.name.length); // "Guest bedroom" before "Bedroom"

  for (const device of devices) {
    const p = placed.get(device.id);
    if (p) {
      result.set(device.id, { position: p.position, roomId: p.roomId, placed: true });
      continue;
    }
    const text = `${device.name} ${hints.get(device.id) ?? ''}`.toLowerCase();
    const room = rooms.find((r) => text.includes(r.name.toLowerCase()));
    if (room) {
      if (!perRoom.has(room.id)) perRoom.set(room.id, []);
      perRoom.get(room.id).push(device);
    } else leftovers.push(device);
  }

  for (const [roomId, list] of perRoom) {
    const room = plan.rooms.find((r) => r.id === roomId);
    const [cx, cz] = centroid(room.points);
    const b = bounds([room]);
    const radius = list.length > 1 ? Math.min(b.maxX - b.minX, b.maxZ - b.minZ) * 0.25 : 0;
    list.forEach((device, i) => {
      const angle = (i / list.length) * Math.PI * 2;
      result.set(device.id, {
        position: [round(cx + Math.cos(angle) * radius), defaultHeight(device), round(cz + Math.sin(angle) * radius)],
        roomId,
        placed: false,
      });
    });
  }

  const b = bounds(plan.rooms);
  const width = Math.max(b.maxX - b.minX, 3);
  const perRow = Math.max(1, Math.floor(width / 1));
  leftovers.forEach((device, i) => {
    const x = b.minX + 0.5 + (i % perRow) * 1;
    const z = b.maxZ + 1 + Math.floor(i / perRow) * 1;
    result.set(device.id, { position: [round(x), defaultHeight(device), round(z)], roomId: null, placed: false });
  });
  return result;
}

const round = (n) => Math.round(n * 100) / 100;

/** One short line describing a device's state for its 3D label, e.g. "On · 40%" or "21.5 °C · 48 %". */
export function deviceSummary(device) {
  const { primary } = splitCapabilities(device.capabilities);
  const byProp = (prop) => primary.find((c) => c.property === prop);
  const parts = [];
  const pretty = (text) => (/^[A-Z_]+$/.test(text) ? text.charAt(0) + text.slice(1).toLowerCase().replace(/_/g, ' ') : text);
  const state = byProp('state') ?? primary.find((c) => c.type === 'binary' && c.writable);
  if (state && device.state[state.property] !== undefined) parts.push(formatValue(state, device.state[state.property]));
  const brightness = byProp('brightness');
  if (brightness && state && device.state[state.property] === state.valueOn && typeof device.state.brightness === 'number') {
    parts.push(`${Math.round(((device.state.brightness - (brightness.min ?? 0)) / ((brightness.max ?? 254) - (brightness.min ?? 0))) * 100)}%`);
  }
  for (const prop of ['temperature', 'humidity', 'position']) {
    const cap = byProp(prop);
    if (cap && device.state[prop] !== undefined) parts.push(formatValue(cap, device.state[prop]));
  }
  if (!parts.length) {
    const binaries = primary.filter((c) => c.type === 'binary' && device.state[c.property] !== undefined);
    if (binaries.length) {
      const on = binaries.filter((c) => device.state[c.property] === c.valueOn).length;
      parts.push(`${on}/${binaries.length} on`);
    }
  }
  if (device.available === false) parts.unshift('Offline');
  return parts.slice(0, 2).map(pretty).join(' · ');
}

/** 0 (off) to 1 (full) for lights, null for devices that do not emit light. */
export function lightLevel(device) {
  if (deviceIcon(device) !== 'light') return null;
  if (device.available === false) return 0;
  const state = device.capabilities.find((c) => c.property === 'state');
  if (!state || device.state.state !== state.valueOn) return 0;
  const b = device.capabilities.find((c) => c.property === 'brightness');
  if (!b || typeof device.state.brightness !== 'number') return 1;
  const min = b.min ?? 0;
  const max = b.max ?? 254;
  return Math.max(0.05, Math.min(1, (device.state.brightness - min) / (max - min || 1)));
}
