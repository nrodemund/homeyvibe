import { parseExposes, validateValue } from './capabilities.js';
import { RegistryError } from '../../devices/registry.js';

export const PROVIDER_ID = 'zigbee2mqtt';

/**
 * zigbee2mqtt provider. Discovers devices from `<base>/bridge/devices`, tracks
 * live state from `<base>/<friendly_name>` and availability from
 * `<base>/<friendly_name>/availability`.
 *
 * @param {object} opts
 * @param {import('mqtt').MqttClient} opts.client connected (or connecting) MQTT client
 * @param {import('../../devices/registry.js').DeviceRegistry} opts.registry
 * @param {string} [opts.baseTopic]
 * @param {(msg: string) => void} [opts.log]
 */
export function createZigbee2mqttProvider({ client, registry, baseTopic = 'zigbee2mqtt', log = () => {} }) {
  const byFriendlyName = new Map(); // friendly_name -> device id
  const base = baseTopic.replace(/\/+$/, '');

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
      await publish(`${base}/${device.meta.friendlyName}/set`, JSON.stringify(values));
      return { sent: values };
    },
  };

  function publish(topic, payload) {
    return new Promise((resolve, reject) =>
      client.publish(topic, payload, (err) => (err ? reject(err) : resolve())),
    );
  }

  function handleDevices(list) {
    if (!Array.isArray(list)) return;
    const keep = new Set();
    byFriendlyName.clear();
    for (const d of list) {
      if (d.type === 'Coordinator' || !d.ieee_address) continue;
      const id = `z2m:${d.ieee_address}`;
      keep.add(id);
      byFriendlyName.set(d.friendly_name, id);
      registry.upsert({
        id,
        provider: PROVIDER_ID,
        name: d.friendly_name,
        model: d.definition?.model ?? d.model_id ?? null,
        vendor: d.definition?.vendor ?? d.manufacturer ?? null,
        description: d.definition?.description ?? null,
        supported: Boolean(d.supported ?? d.definition),
        interviewing: Boolean(d.interviewing),
        capabilities: parseExposes(d.definition?.exposes),
        meta: { ieee: d.ieee_address, friendlyName: d.friendly_name, powerSource: d.power_source ?? null },
      });
    }
    registry.prune(PROVIDER_ID, keep);
    log(`zigbee2mqtt: ${keep.size} device(s) discovered`);
  }

  function onMessage(topic, payload) {
    if (!topic.startsWith(`${base}/`)) return;
    const rest = topic.slice(base.length + 1);
    if (rest === 'bridge/devices') return handleDevices(parseJson(payload));
    if (rest.startsWith('bridge/')) return;

    if (rest.endsWith('/availability')) {
      const id = byFriendlyName.get(rest.slice(0, -'/availability'.length));
      if (!id) return;
      const text = payload.toString();
      const parsed = parseJson(payload);
      const state = parsed?.state ?? text; // z2m >= 1.30 sends JSON, older sends plain text
      registry.setAvailable(id, state === 'online');
      return;
    }

    const id = byFriendlyName.get(rest);
    if (!id) return; // e.g. "<name>/set", "<name>/get", or unknown device
    const state = parseJson(payload);
    if (state && typeof state === 'object') registry.updateState(id, state);
  }

  client.on('message', onMessage);
  client.on('connect', () => {
    client.subscribe([`${base}/bridge/devices`, `${base}/+`, `${base}/+/availability`]);
  });
  if (client.connected) client.subscribe([`${base}/bridge/devices`, `${base}/+`, `${base}/+/availability`]);

  registry.registerProvider(provider);
  return provider;
}

function parseJson(payload) {
  try {
    return JSON.parse(payload.toString());
  } catch {
    return null;
  }
}
