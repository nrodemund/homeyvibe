// Decides how each device capability is shown. Pure functions, no DOM, so they can be unit-tested.

/**
 * @returns {'toggle'|'slider'|'buttons'|'select'|'value'|'json'|'hidden'}
 */
export function controlKind(cap) {
  if (!cap.readable && !cap.writable) return 'hidden';
  switch (cap.type) {
    case 'binary':
      return cap.writable ? 'toggle' : 'value';
    case 'numeric':
      return cap.writable && cap.min !== null && cap.max !== null ? 'slider' : 'value';
    case 'enum':
      if (!cap.writable) return 'value';
      return cap.values.length <= 4 ? 'buttons' : 'select';
    case 'text':
      return 'value';
    case 'composite':
    case 'list':
      return cap.readable ? 'json' : 'hidden';
    default:
      return 'value';
  }
}

/** Primary capabilities first, diagnostics (link quality, battery, ...) separated out. */
export function splitCapabilities(capabilities) {
  const primary = [];
  const diagnostic = [];
  for (const cap of capabilities) {
    if (controlKind(cap) === 'hidden') continue;
    (cap.category === 'diagnostic' ? diagnostic : primary).push(cap);
  }
  return { primary, diagnostic };
}

/** Human label: explicit label, else "color_temp" -> "Color temp". */
export function labelFor(cap) {
  if (cap.name && cap.name !== cap.property && /[A-Z ]/.test(cap.name)) return cap.name;
  const raw = cap.name && cap.name !== 'state' ? cap.name : cap.property;
  const text = raw.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatValue(cap, value) {
  if (value === undefined || value === null) return '–';
  if (cap.type === 'binary') {
    if (value === cap.valueOn) return 'On';
    if (value === cap.valueOff) return 'Off';
  }
  if (typeof value === 'number') {
    const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
    return cap.unit ? `${rounded} ${cap.unit}` : String(rounded);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Pick an icon name for a device from its capability groups. */
export function deviceIcon(device) {
  const groups = new Set(device.capabilities.map((c) => (c.group ?? '').split('_')[0]));
  for (const g of ['light', 'cover', 'switch', 'climate', 'lock', 'fan']) if (groups.has(g)) return g;
  const props = new Set(device.capabilities.map((c) => c.property));
  if (props.has('temperature') || props.has('humidity')) return 'sensor';
  if (props.has('occupancy') || props.has('contact')) return 'sensor';
  return 'device';
}
