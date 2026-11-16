// Turns zigbee2mqtt "exposes" definitions into a flat list of HomeyVibe capabilities.
// See https://www.zigbee2mqtt.io/guide/usage/exposes.html

const ACCESS_STATE = 0b001; // value is published in the device state
const ACCESS_SET = 0b010; // value can be set
const ACCESS_GET = 0b100; // value can be requested

// Generic composite types that group features of one function (a light, a switch, ...).
const GROUP_TYPES = new Set(['light', 'switch', 'fan', 'cover', 'lock', 'climate']);

/**
 * @param {Array} exposes zigbee2mqtt definition.exposes
 * @returns {Array<object>} capabilities, each with a unique `property`
 */
export function parseExposes(exposes = []) {
  const out = [];
  for (const expose of exposes) collect(expose, null, out);
  return out;
}

function collect(expose, group, out) {
  if (GROUP_TYPES.has(expose.type)) {
    const groupName = expose.endpoint ? `${expose.type}_${expose.endpoint}` : expose.type;
    for (const feature of expose.features ?? []) collect(feature, groupName, out);
    return;
  }
  const property = expose.property ?? expose.name;
  if (!property) return;
  out.push(toCapability(expose, property, group));
}

function toCapability(expose, property, group) {
  const access = expose.access ?? ACCESS_STATE;
  const cap = {
    property,
    name: expose.label ?? expose.name ?? property,
    type: expose.type,
    group,
    endpoint: expose.endpoint ?? null,
    readable: Boolean(access & ACCESS_STATE),
    writable: Boolean(access & ACCESS_SET),
    gettable: Boolean(access & ACCESS_GET),
    description: expose.description ?? null,
    category: expose.category ?? null,
  };
  switch (expose.type) {
    case 'binary':
      cap.valueOn = expose.value_on;
      cap.valueOff = expose.value_off;
      if (expose.value_toggle !== undefined) cap.valueToggle = expose.value_toggle;
      break;
    case 'numeric':
      cap.unit = expose.unit ?? null;
      cap.min = expose.value_min ?? null;
      cap.max = expose.value_max ?? null;
      cap.step = expose.value_step ?? null;
      if (expose.presets?.length) cap.presets = expose.presets.map(({ name, value }) => ({ name, value }));
      break;
    case 'enum':
      cap.values = expose.values ?? [];
      break;
    case 'composite':
    case 'list':
      cap.features = (expose.features ?? (expose.item_type ? [expose.item_type] : []))
        .map((f) => toCapability(f, f.property ?? f.name, null));
      break;
  }
  return cap;
}

/**
 * Validate a value for a capability. Returns an error message or null.
 */
export function validateValue(cap, value) {
  if (!cap.writable) return `${cap.property} is read-only`;
  switch (cap.type) {
    case 'binary': {
      const allowed = [cap.valueOn, cap.valueOff, cap.valueToggle].filter((v) => v !== undefined);
      return allowed.includes(value) ? null : `${cap.property} must be one of ${JSON.stringify(allowed)}`;
    }
    case 'numeric': {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${cap.property} must be a number`;
      if (cap.min !== null && value < cap.min) return `${cap.property} must be >= ${cap.min}`;
      if (cap.max !== null && value > cap.max) return `${cap.property} must be <= ${cap.max}`;
      return null;
    }
    case 'enum':
      return cap.values.includes(value) ? null : `${cap.property} must be one of ${JSON.stringify(cap.values)}`;
    case 'text':
      return typeof value === 'string' ? null : `${cap.property} must be a string`;
    case 'composite':
      return value && typeof value === 'object' && !Array.isArray(value) ? null : `${cap.property} must be an object`;
    case 'list':
      return Array.isArray(value) ? null : `${cap.property} must be an array`;
    default:
      return null;
  }
}
