// Device limits (who may see and control what, within which values). Pure helpers, no DOM.

export const ACCESS_LABELS = { control: 'Control', view: 'View only', hidden: 'Hidden' };

/** Capabilities a value range can be set on: writable numbers with a known range. */
export function limitableCaps(device) {
  return device.capabilities.filter((c) => c.type === 'numeric' && c.writable && c.min !== null && c.max !== null
    && c.category !== 'diagnostic');
}

/** Access level and ranges for one device under `limits`. */
export function entryFor(limits, deviceId) {
  const entry = limits.devices?.[deviceId];
  return { access: entry?.access ?? limits.default ?? 'control', ranges: entry?.ranges ?? {} };
}

/**
 * Parse a min/max input pair. Empty fields fall back to the capability's own range;
 * returns null when the result is the capability's full range (no limit).
 */
export function parseRange(cap, minText, maxText) {
  const min = minText === '' || minText === undefined ? cap.min : Number(minText);
  const max = maxText === '' || maxText === undefined ? cap.max : Number(maxText);
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`${cap.label ?? cap.property}: enter numbers`);
  if (min > max) throw new Error(`${cap.label ?? cap.property}: the lowest value is above the highest`);
  if (min < cap.min || max > cap.max) throw new Error(`${cap.label ?? cap.property}: stay within ${cap.min}–${cap.max}`);
  if (min === cap.min && max === cap.max) return null;
  return [min, max];
}

/** Short, plain-language summary of limits, e.g. "2 hidden · 1 view only · 1 range". */
export function summarize(limits) {
  const entries = Object.values(limits?.devices ?? {});
  const parts = [];
  if (limits?.default && limits.default !== 'control') parts.push(`new devices ${ACCESS_LABELS[limits.default].toLowerCase()}`);
  const count = (a) => entries.filter((e) => e.access === a).length;
  if (count('hidden')) parts.push(`${count('hidden')} hidden`);
  if (count('view')) parts.push(`${count('view')} view only`);
  const ranges = entries.reduce((n, e) => n + Object.keys(e.ranges ?? {}).length, 0);
  if (ranges) parts.push(`${ranges} value ${ranges === 1 ? 'range' : 'ranges'}`);
  return parts.length ? parts.join(' · ') : 'No limits';
}
