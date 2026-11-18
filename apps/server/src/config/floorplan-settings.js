import { CHART_RANGES, CLICK_MODES, DISPLAYS, NUMERIC_DISPLAYS, ROOM_STYLES } from '../../../../packages/shared/src/floorplan.js';
import { validateValue } from '../providers/zigbee2mqtt/capabilities.js';
import { ID_RE } from './validate.js';
import { checkActionSteps } from './actions.js';
import { checkTimer, validateTimerInput } from '../devices/timers.js';

const color = (value) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
const number = (value, min = -Infinity, max = Infinity) => Number.isFinite(value) && value >= min && value <= max;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));

/** Validate and copy optional style fields and openings in meters along each wall. */
export function roomSettings(room, path, v) {
  const extras = {};
  if (room.style !== undefined && v.check(record(room.style), `${path}.style must be an object`)) {
    const style = pick(room.style, ROOM_STYLES);
    for (const key of ['floorColor', 'wallColor', 'edgeColor']) {
      if (key in style) v.check(color(style[key]), `${path}.style.${key} must be a hex color such as #5588cc`);
    }
    for (const [key, min, max] of [['wallHeight', 0.2, room.height ?? 2.5], ['wallThickness', 0.02, 1], ['wallOpacity', 0, 1]]) {
      if (key in style) v.check(number(style[key], min, max), `${path}.style.${key} must be between ${min} and ${max}`);
    }
    if ('edges' in style) v.check(typeof style.edges === 'boolean', `${path}.style.edges must be true or false`);
    if (Object.keys(style).length) extras.style = style;
  }
  if (room.openings !== undefined && v.array(room.openings, `${path}.openings`, { max: 64 })) {
    const openings = [];
    room.openings.forEach((entry, i) => {
      const key = `${path}.openings[${i}]`;
      if (!v.check(record(entry), `${key} must be an object`)) return;
      const { type, edge, offset, width, height } = entry;
      const bottom = entry.bottom ?? (type === 'window' ? 0.8 : 0);
      v.oneOf(type, ['door', 'window'], `${key}.type`);
      const edgeValid = v.check(Number.isInteger(edge) && edge >= 0 && edge < (room.points?.length ?? 0), `${key}.edge must identify a wall`);
      const offsetValid = v.check(number(offset, 0), `${key}.offset must be zero or more meters`);
      const widthValid = v.check(number(width, 0.1), `${key}.width must be at least 0.1 m`);
      const bottomValid = v.check(number(bottom, 0) && (type !== 'door' || bottom === 0), `${key}.bottom must be a valid height (0 for a door)`);
      const heightValid = v.check(number(height, 0.1), `${key}.height must be at least 0.1 m`);
      if (!(edgeValid && offsetValid && widthValid && bottomValid && heightValid)) return;
      const [a, b] = [room.points[edge], room.points[(edge + 1) % room.points.length]];
      if (Array.isArray(a) && Array.isArray(b)) {
        v.check(offset + width <= Math.hypot(a[0] - b[0], a[1] - b[1]) + 0.001, `${key} extends beyond the wall`);
      }
      v.check(bottom + height <= (room.height ?? 2.5) + 0.001, `${key} extends above the room`);
      v.check(!openings.some((other) => other.edge === edge &&
        offset < other.offset + other.width - 0.001 && other.offset < offset + width - 0.001 &&
        bottom < other.bottom + other.height - 0.001 && other.bottom < bottom + height - 0.001),
      `${key} overlaps another opening`);
      openings.push({ type, edge, offset, width, bottom, height });
    });
    if (openings.length) extras.openings = openings;
  }
  return extras;
}

/** Validate and copy the optional display, click and lighting fields of one placement. */
export function placementSettings(placement, path, v) {
  const extras = {};
  if (placement.hidden !== undefined && v.check(typeof placement.hidden === 'boolean', `${path}.hidden must be a boolean`) && placement.hidden) {
    extras.hidden = true;
  }
  if (placement.display !== undefined && v.check(record(placement.display), `${path}.display must be an object`)) {
    const d = pick(placement.display, ['mode', 'property', 'min', 'max', 'threshold', 'lowColor', 'highColor']);
    v.oneOf(d.mode, Object.keys(DISPLAYS), `${path}.display.mode`);
    if (d.property !== undefined) v.string(d.property, `${path}.display.property`, { max: 64 });
    for (const key of ['min', 'max', 'threshold']) {
      if (key in d) v.check(number(d[key]), `${path}.display.${key} must be finite`);
    }
    if (d.min !== undefined && d.max !== undefined) v.check(d.min < d.max, `${path}.display.max must be above min`);
    for (const key of ['lowColor', 'highColor']) {
      if (key in d) v.check(color(d[key]), `${path}.display.${key} must be a hex color such as #5588cc`);
    }
    if (d.mode !== 'auto') extras.display = d;
  }
  if (placement.click !== undefined && v.check(record(placement.click), `${path}.click must be an object`)) {
    const { mode, values, actionId, message } = placement.click;
    v.oneOf(mode, CLICK_MODES, `${path}.click.mode`);
    if (mode === 'command') {
      v.check(record(values) && Object.keys(values).length > 0 && Object.keys(values).length <= 32 &&
        Object.keys(values).every((key) => key.length > 0 && key.length <= 64 && key !== '__proto__'),
      `${path}.click.values must contain 1 to 32 device properties`);
      if (placement.click.timer !== undefined) validateTimerInput(placement.click.timer, `${path}.click`, v);
      extras.click = { mode, values, ...(placement.click.timer ? { timer: placement.click.timer } : {}) };
    } else if (mode === 'action') {
      v.check(typeof actionId === 'string' && ID_RE.test(actionId), `${path}.click.actionId must identify an action`);
      extras.click = { mode, actionId };
    } else if (mode === 'message') {
      v.string(message, `${path}.click.message`, { max: 200 });
      extras.click = { mode, message };
    } else if (mode === 'chart') {
      const chart = pick(placement.click, ['mode', 'property', 'range', 'min', 'max']);
      v.string(chart.property, `${path}.click.property`, { max: 64 });
      if ('range' in chart) v.oneOf(chart.range, Object.keys(CHART_RANGES), `${path}.click.range`);
      for (const key of ['min', 'max']) if (key in chart) v.check(number(chart[key]), `${path}.click.${key} must be finite`);
      if ('min' in chart && 'max' in chart) v.check(chart.min < chart.max, `${path}.click.max must be above min`);
      extras.click = chart;
    } else if (mode === 'none') extras.click = { mode };
  }
  if (placement.light !== undefined && v.check(record(placement.light), `${path}.light must be an object`)) {
    const light = pick(placement.light, ['enabled', 'strength', 'color']);
    if ('enabled' in light) v.check(typeof light.enabled === 'boolean', `${path}.light.enabled must be true or false`);
    if ('strength' in light) v.check(number(light.strength, 0, 2), `${path}.light.strength must be between 0 and 2`);
    if ('color' in light) v.check(color(light.color), `${path}.light.color must be a hex color such as #ffcc77`);
    if (Object.keys(light).length) extras.light = light;
  }
  return extras;
}

/** Check changed placement settings against live capabilities and configured actions. */
export function checkPlacementSettings(plan, previous, { registry, lookupAction, canControl = true }) {
  const old = new Map(previous.devices.map((entry) => [entry.deviceId, entry]));
  const errors = [];
  for (const [index, entry] of plan.devices.entries()) {
    const path = `floorplan.devices[${index}]`;
    const device = registry.get(entry.deviceId);
    const unchanged = (key) => JSON.stringify(entry[key]) === JSON.stringify(old.get(entry.deviceId)?.[key]);
    if (entry.display?.property && !unchanged('display')) {
      const cap = device?.capabilities.find((c) => c.property === entry.display.property && c.readable);
      if (!cap) errors.push(`${path}.display.property must be a readable device property`);
      else if (NUMERIC_DISPLAYS.includes(entry.display.mode) && cap.type !== 'numeric') {
        errors.push(`${path}.display.mode requires a number`);
      } else if (entry.display.mode === 'status' && cap.type !== 'binary') {
        errors.push(`${path}.display.mode requires an on/off property`);
      }
    }
    const click = entry.click;
    if (!click || unchanged('click')) continue;
    if (click.mode === 'chart' && !device?.capabilities.some((cap) => cap.property === click.property && cap.readable && cap.type === 'numeric')) {
      errors.push(`${path}.click.property must be a readable numeric device property`);
    }
    if (click.mode === 'command' || click.mode === 'action') {
      if (!canControl || device?.access === 'view') errors.push(`${path}.click needs device control permission`);
      if (click.mode === 'command') {
        for (const [key, value] of Object.entries(click.values)) {
          const cap = device?.capabilities.find((c) => c.property === key);
          const problem = cap ? validateValue(cap, value) : `Unknown capability ${key}`;
          if (problem) errors.push(`${path}.click: ${problem}`);
        }
        try { registry.check?.(entry.deviceId, click.values); } catch (err) { errors.push(`${path}.click: ${err.message}`); }
        if (click.timer && device) try {
          checkTimer(device, click.timer);
          registry.check?.(entry.deviceId, click.timer.values);
        } catch (err) { errors.push(`${path}.click.timer: ${err.message}`); }
      } else {
        try {
          checkActionSteps(click.actionId, lookupAction, registry.check ?? (() => {}));
        } catch (err) {
          errors.push(`${path}.click: ${err.message}`);
        }
      }
    }
  }
  return errors;
}

/** Hide other users' device placements and keep quick commands private from view-only users. */
export function visibleFloorplan(plan, policy, canControl) {
  return {
    ...plan,
    devices: plan.devices.filter((entry) => !policy || policy.canSee(entry.deviceId)).map((entry) => {
      if (canControl && policy?.access(entry.deviceId) !== 'view') return entry;
      if (!['command', 'action'].includes(entry.click?.mode)) return entry;
      const { click, ...visible } = entry;
      return visible;
    }),
  };
}
