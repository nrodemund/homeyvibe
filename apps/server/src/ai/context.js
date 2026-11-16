// Builds a plain-text description of the home for language models: what devices exist,
// what each can do, what is already configured, and the formats for pages and actions.
// Used by the MCP server and by the downloadable context file.

import { LAYOUTS } from '../config/pages.js';
import { DAYS, OPERATORS } from '../config/actions.js';

/** Compact, model-friendly view of one device. */
export function describeDevice(device) {
  return {
    id: device.id,
    name: device.name,
    vendor: device.vendor,
    model: device.model,
    description: device.description,
    available: device.available !== false,
    capabilities: device.capabilities.map((c) => {
      const cap = { property: c.property, type: c.type, access: access(c) };
      if (c.group) cap.group = c.group;
      if (c.unit) cap.unit = c.unit;
      if (c.min !== null && c.min !== undefined) cap.min = c.min;
      if (c.max !== null && c.max !== undefined) cap.max = c.max;
      if (c.values) cap.values = c.values;
      if (c.valueOn !== undefined) cap.on = c.valueOn;
      if (c.valueOff !== undefined) cap.off = c.valueOff;
      if (c.category) cap.category = c.category;
      if (device.ranges?.[c.property]) cap.allowed = device.ranges[c.property];
      return cap;
    }),
    ...(device.access === 'view' ? { access: 'view' } : {}),
    state: device.state,
  };
}

function access(c) {
  return [c.readable && 'read', c.writable && 'write'].filter(Boolean).join('+') || 'none';
}

export const FORMAT_GUIDE = `## Page format

A page is a dashboard tab:

\`\`\`json
{
  "title": "Living room",
  "icon": "🛋️",
  "layout": "grid",
  "sections": [
    { "title": "Scenes", "items": [{ "type": "action", "actionId": "movie-night" }] },
    { "title": "Lights", "items": [{ "type": "device", "deviceId": "<device id>", "properties": ["state", "brightness"] }] }
  ]
}
\`\`\`

- layout: one of ${LAYOUTS.join(', ')}
- items: \`{ "type": "device", "deviceId", "properties"? }\` (omit properties to show every capability) or \`{ "type": "action", "actionId" }\`
- id is generated from the title unless given (lowercase letters, numbers, dashes)

## Action format

An action is a named list of steps, optionally run automatically by triggers:

\`\`\`json
{
  "name": "Movie night",
  "description": "Dim the lights and close the blinds",
  "steps": [
    { "type": "set", "deviceId": "<device id>", "values": { "state": "ON", "brightness": 40 } },
    { "type": "delay", "seconds": 2 },
    { "type": "run", "actionId": "close-blinds" }
  ],
  "triggers": [
    { "type": "state", "deviceId": "<sensor id>", "property": "humidity", "op": "gt", "value": 70 },
    { "type": "time", "at": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"] }
  ]
}
\`\`\`

- set: values must fit the device's capabilities (writable, within min/max, one of the listed values; binary uses its on/off values)
- triggers are optional; op is one of ${OPERATORS.join(', ')}; days are ${DAYS.join(', ')}; time is the server's local time
- id is generated from the name unless given

## Floor plan format (3D pages)

Pages with layout "3d" show the home's floor plan with devices placed in it. There is one plan for the whole home:

\`\`\`json
{
  "rooms": [
    { "name": "Living room", "floor": 0, "height": 2.5, "points": [[0, 0], [5, 0], [5, 4], [0, 4]] },
    { "name": "Kitchen", "points": [[5, 0], [8, 0], [8, 4], [5, 4]] }
  ],
  "devices": [
    { "deviceId": "<device id>", "roomId": "living-room", "position": [2.5, 2.2, 2] }
  ]
}
\`\`\`

- Coordinates are meters seen from above; points are the room's corners in order as [x, z]; neighbouring rooms share walls
- position is [x, height above the floor, z]; ceiling lights sit near the ceiling, sensors and switches around 1.2–1.5
- room ids are generated from names; floor 0 is the ground floor
- A 3D page shows the devices listed in its sections, or every placed device when it lists none

## Good configuration

- Group devices by room when names hint at rooms; otherwise by kind (lights, climate, covers).
- Show only the useful capabilities on room pages (power, brightness, position); leave diagnostics (battery, link quality) for the "All devices" view.
- Offer a few scenes per room (all off, evening, movie) rather than many.
- Only use device ids and properties that exist below.
- A device with "access": "view" is read only for you; a capability with "allowed": [min, max] only accepts values in that range.
`;

/** Full context document (Markdown). */
export function buildContext({ registry, pages, actions, floorplan = null, now = new Date() }) {
  const devices = registry.list().map(describeDevice);
  return `# HomeyVibe home configuration context

Generated ${now.toISOString()}. HomeyVibe is a smart home server. Use this document to propose dashboard pages and actions for this home.
Reply with JSON of the form \`{ "pages": [ … ], "actions": [ … ], "floorplan"?: { … } }\` using the formats below; it can be imported in HomeyVibe under Settings → AI → Import.

${FORMAT_GUIDE}
## Devices (${devices.length})

\`\`\`json
${JSON.stringify(devices, null, 2)}
\`\`\`

## Existing pages (${pages.list().length})

\`\`\`json
${JSON.stringify(pages.list(), null, 2)}
\`\`\`

## Existing actions (${actions.list().length})

\`\`\`json
${JSON.stringify(actions.list(), null, 2)}
\`\`\`
${floorplan ? `
## Floor plan (${floorplan.get().rooms.length} rooms)

\`\`\`json
${JSON.stringify(floorplan.get(), null, 2)}
\`\`\`
` : ''}`;
}
