import { readFileSync } from 'node:fs';
import { parseExposes, validateValue } from '../zigbee2mqtt/capabilities.js';
import { RegistryError } from '../../devices/registry.js';

export const PROVIDER_ID = 'demo';

const fixture = new URL('./devices.json', import.meta.url);

/**
 * Simulated devices for trying HomeyVibe without hardware (HOMEYVIBE_DEMO=1).
 * Commands are applied straight to state; sensors drift slowly.
 */
export function createDemoProvider({ registry, tickMs = 5000 }) {
  const definitions = JSON.parse(readFileSync(fixture, 'utf8'));
  const provider = {
    id: PROVIDER_ID,
    async command(device, values) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new RegistryError(400, 'Body must be an object of { property: value }');
      }
      const errors = [];
      for (const [property, value] of Object.entries(values)) {
        const cap = device.capabilities.find((c) => c.property === property);
        const err = cap ? validateValue(cap, value) : `Unknown capability ${property}`;
        if (err) errors.push(err);
      }
      if (errors.length) throw new RegistryError(400, errors.join('; '));
      const changes = {};
      for (const [property, value] of Object.entries(values)) {
        const cap = device.capabilities.find((c) => c.property === property);
        if (cap.type === 'binary' && value === cap.valueToggle) {
          changes[property] = device.state[property] === cap.valueOn ? cap.valueOff : cap.valueOn;
        } else if (cap.readable) {
          changes[property] = value;
        }
      }
      registry.updateState(device.id, changes);
      return { sent: values };
    },
  };
  registry.registerProvider(provider);

  for (const d of definitions) {
    const id = `demo:${d.id}`;
    registry.upsert({
      id,
      provider: PROVIDER_ID,
      name: d.name,
      model: d.model,
      vendor: d.vendor,
      description: d.description,
      supported: true,
      interviewing: false,
      capabilities: parseExposes(d.exposes),
      meta: {},
    });
    registry.updateState(id, d.state);
  }

  const timer = setInterval(() => {
    for (const device of registry.list()) {
      if (device.provider !== PROVIDER_ID) continue;
      const drift = {};
      for (const key of ['temperature', 'humidity']) {
        if (typeof device.state[key] === 'number') {
          drift[key] = Math.round((device.state[key] + (Math.random() - 0.5) * 0.4) * 10) / 10;
        }
      }
      if (Object.keys(drift).length) registry.updateState(device.id, drift);
    }
  }, tickMs);
  timer.unref();
  provider.stop = () => clearInterval(timer);
  return provider;
}

/** Example pages and actions for demo mode, only added when none exist yet. */
export function seedDemoConfig({ pages, actions }) {
  if (actions.list().length === 0) {
    actions.create({
      id: 'movie-night',
      name: 'Movie night',
      description: 'Dim the lamp and close the blind',
      steps: [
        { type: 'set', deviceId: 'demo:living_room_lamp', values: { state: 'ON', brightness: 40, color_temp: 450 } },
        { type: 'set', deviceId: 'demo:bedroom_blind', values: { position: 0 } },
      ],
    });
    actions.create({
      id: 'all-lights-off',
      name: 'All lights off',
      steps: [
        { type: 'set', deviceId: 'demo:living_room_lamp', values: { state: 'OFF' } },
        { type: 'set', deviceId: 'demo:hallway_switch', values: { state_left: 'OFF', state_right: 'OFF' } },
      ],
    });
  }
  if (pages.list().length === 0) {
    pages.create({
      id: 'living-room',
      title: 'Living room',
      icon: '🛋️',
      sections: [
        { title: 'Scenes', items: [{ type: 'action', actionId: 'movie-night' }, { type: 'action', actionId: 'all-lights-off' }] },
        { title: 'Lights', items: [{ type: 'device', deviceId: 'demo:living_room_lamp', properties: ['state', 'brightness'] }] },
      ],
    });
    pages.create({
      id: 'climate',
      title: 'Climate',
      icon: '🌡️',
      sections: [{ items: [{ type: 'device', deviceId: 'demo:bathroom_sensor' }, { type: 'device', deviceId: 'demo:bedroom_blind' }] }],
    });
  }
}
