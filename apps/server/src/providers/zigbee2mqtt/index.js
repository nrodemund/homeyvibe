import { parseExposes, validateValue } from './capabilities.js';
import { RegistryError } from '../../devices/registry.js';

export const PROVIDER_ID = 'zigbee2mqtt';
const CATALOG = '/bridge/devices';
const BRIDGE_STATE = '/bridge/state';
const DISCOVERY_WINDOW_MS = 750;

/** Discover the retained device catalog, then subscribe to the exact topics for those devices. */
export function createZigbee2mqttProvider({
  client, registry, baseTopic = 'zigbee2mqtt', report = () => {}, discoveryWindow = DISCOVERY_WINDOW_MS,
}) {
  let base = baseTopic.replace(/\/+$/, '');
  let bridgeOnline = null;
  let ready = false;
  let disposed = false;
  let timer;
  let subscribed = new Set();
  const candidates = new Map();
  const names = new Map();
  const availability = new Map();

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
      const name = device.meta.friendlyName;
      if (!client.connected || !ready || bridgeOnline === false || names.get(name) !== device.id) {
        throw new RegistryError(503, 'Zigbee2MQTT is offline or still discovering devices');
      }
      await new Promise((resolve, reject) =>
        client.publish(`${base}/${name}/set`, JSON.stringify(values), (err) => (err ? reject(err) : resolve())),
      );
      return { sent: values };
    },
    close() {
      disposed = true;
      disconnect();
      client.off('connect', connect);
      client.off('close', disconnect);
      client.off('message', onMessage);
    },
  };

  function subscribe(topics) {
    if (!topics.length) return;
    client.subscribe(topics, (err, grants, packet) => {
      if (disposed || !client.connected) return;
      const failed = packet?.granted
        ? topics.filter((topic, index) => packet.granted[index] >= 128)
        : err ? topics : grants?.filter(({ qos }) => qos >= 128).map(({ topic }) => topic) ?? [];
      if (failed.includes(base ? `${base}${CATALOG}` : `+${CATALOG}`)) {
        report({ phase: 'subscription-denied' });
      } else if (failed.length) {
        report({ limited: true });
      }
    });
  }

  function connect() {
    report({ phase: 'waiting', detectedBase: base || null, limited: false });
    subscribe(base ? [`${base}${CATALOG}`, `${base}${BRIDGE_STATE}`] : [`+${CATALOG}`]);
  }

  function disconnect() {
    clearTimeout(timer);
    timer = undefined;
    candidates.clear();
    subscribed.clear();
    availability.clear();
    ready = false;
    bridgeOnline = null;
    for (const id of names.values()) registry.setAvailable(id, false);
  }

  function reportCatalog() {
    if (ready) report({ phase: bridgeOnline === false ? 'bridge-offline' : 'ready', detectedBase: base, deviceCount: names.size });
  }

  function handleDevices(list) {
    const keep = new Set();
    const next = new Set();
    names.clear();
    for (const d of list) {
      if (d.type === 'Coordinator') continue;
      const id = `z2m:${d.ieee_address}`;
      const name = d.friendly_name || d.ieee_address;
      if (!validDeviceTopic(name)) continue;
      keep.add(id);
      names.set(name, id);
      next.add(`${base}/${name}`);
      next.add(`${base}/${name}/availability`);
      registry.upsert({
        id,
        provider: PROVIDER_ID,
        name,
        model: d.definition?.model ?? d.model_id ?? null,
        vendor: d.definition?.vendor ?? d.manufacturer ?? null,
        description: d.definition?.description ?? null,
        supported: Boolean(d.supported ?? d.definition),
        interviewing: Boolean(d.interviewing),
        capabilities: parseExposes(d.definition?.exposes),
        available: bridgeOnline !== false && (availability.get(name) ?? true),
        meta: { ieee: d.ieee_address, friendlyName: name, powerSource: d.power_source ?? null },
      });
    }
    registry.prune(PROVIDER_ID, keep);
    for (const name of availability.keys()) if (!names.has(name)) availability.delete(name);
    const added = [...next].filter((topic) => !subscribed.has(topic));
    const removed = [...subscribed].filter((topic) => !next.has(topic));
    subscribed = next;
    ready = true;
    reportCatalog();
    if (removed.length) client.unsubscribe(removed);
    subscribe(added);
  }

  function chooseBase() {
    timer = undefined;
    if (candidates.size > 1) {
      report({ phase: 'multiple-bridges', candidates: [...candidates.keys()].sort() });
      return;
    }
    const [[topic, list]] = candidates;
    base = topic;
    candidates.clear();
    client.unsubscribe([`+${CATALOG}`]);
    subscribe([`${base}${CATALOG}`, `${base}${BRIDGE_STATE}`]);
    handleDevices(list);
  }

  function onMessage(topic, payload, packet) {
    if (base ? topic === `${base}${CATALOG}` : /^[^/]+\/bridge\/devices$/.test(topic)) {
      const decoded = parseJson(payload);
      if (!Array.isArray(decoded)) return;
      const list = decoded.filter((d) => d && typeof d.ieee_address === 'string' && d.ieee_address);
      if (decoded.length && !list.length) return;
      if (base) handleDevices(list);
      else {
        candidates.set(topic.slice(0, -CATALOG.length), list);
        timer ??= setTimeout(chooseBase, discoveryWindow);
      }
      return;
    }
    if (!base || !topic.startsWith(`${base}/`)) return;
    const rest = topic.slice(base.length + 1);
    if (rest !== BRIDGE_STATE.slice(1) && !names.has(rest) && !rest.endsWith('/availability')) return;
    const data = parseJson(payload);
    if (rest === BRIDGE_STATE.slice(1)) {
      const state = data?.state ?? payload.toString();
      if (state !== 'online' && state !== 'offline') return;
      bridgeOnline = state === 'online';
      if (!ready && !bridgeOnline) report({ phase: 'bridge-offline', detectedBase: base });
      for (const [name, id] of names) registry.setAvailable(id, bridgeOnline && (availability.get(name) ?? true));
      reportCatalog();
      return;
    }
    // A device's name can itself end in /availability. Prefer its exact state topic.
    if (names.has(rest)) {
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        registry.updateState(names.get(rest), data, { retained: packet?.retain === true });
      }
      return;
    }
    if (rest.endsWith('/availability')) {
      const name = rest.slice(0, -'/availability'.length);
      const state = data?.state ?? payload.toString();
      if (!names.has(name) || (state !== 'online' && state !== 'offline')) return;
      availability.set(name, state === 'online');
      registry.setAvailable(names.get(name), bridgeOnline !== false && state === 'online');
    }
  }

  client.on('message', onMessage);
  client.on('connect', connect);
  client.on('close', disconnect);
  registry.registerProvider(provider);
  if (client.connected) connect();
  return provider;
}

function validDeviceTopic(name) {
  return typeof name === 'string' && !/[+#\x00]/.test(name) && name !== 'bridge' && !name.startsWith('bridge/');
}

function parseJson(payload) {
  try {
    return JSON.parse(payload.toString());
  } catch {
    return null;
  }
}
