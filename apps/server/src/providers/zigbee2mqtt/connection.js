import mqtt from 'mqtt';
import { Validator } from '../../config/validate.js';
import { createZigbee2mqttProvider, PROVIDER_ID } from './index.js';

const AUTO_BROKERS = ['mqtt://mosquitto:1883', 'mqtt://host.docker.internal:1883', 'mqtt://localhost:1883'];
const MQTT_PROTOCOLS = ['mqtt:', 'mqtts:', 'ws:', 'wss:'];

const messages = {
  disabled: 'Zigbee2MQTT discovery is disabled.',
  connecting: 'Connecting to the MQTT broker.',
  waiting: 'MQTT connected. Waiting for the Zigbee2MQTT device catalog. Check the base topic and that Zigbee2MQTT publishes to this broker.',
  'bridge-offline': 'The MQTT broker reports that Zigbee2MQTT is offline. Check the Zigbee2MQTT service.',
  'subscription-denied': 'The broker refused the device catalog subscription. Check the account permissions or enter the exact base topic.',
  'multiple-bridges': 'More than one Zigbee2MQTT catalog was found. Enter the base topic you want to use.',
  'connection-error': 'The MQTT broker could not be reached. Check its address, port and network from the HomeyVibe server.',
  'auth-error': 'The MQTT broker rejected the connection. Check the username, password and broker permissions.',
  'tls-error': 'The MQTT TLS connection failed. Check the broker hostname and the certificates trusted by the HomeyVibe server.',
};

/** Saved settings override deployment defaults. A connection can be changed without restarting the server. */
export class ZigbeeConnection {
  #client;
  #provider;
  #timer;
  #generation = 0;
  #status = { phase: 'disabled' };

  constructor({ registry, store, env = process.env, connect = mqtt.connect, probeMs = 7000, retryMs = 30000 }) {
    this.registry = registry;
    this.store = store;
    this.connect = connect;
    this.probeMs = probeMs;
    this.retryMs = retryMs;
    const supplied = env.MQTT_URL ?? (env.HOMEYVIBE_DEMO === '1' ? '' : 'auto');
    // Existing deployments may have credentials in MQTT_URL. Extract them before exposing the address.
    let url = supplied;
    let username = env.MQTT_USERNAME || '';
    let password = env.MQTT_PASSWORD || '';
    if (supplied && supplied !== 'auto') {
      try {
        const parsed = new URL(supplied);
        if (!MQTT_PROTOCOLS.includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) throw new Error();
        username ||= decodeURIComponent(parsed.username);
        password ||= decodeURIComponent(parsed.password);
        parsed.username = '';
        parsed.password = '';
        url = parsed.href;
      } catch {
        url = '';
      }
    }
    this.defaults = {
      mode: supplied === 'auto' ? 'auto' : url ? 'manual' : 'disabled',
      url, username, password,
      baseTopic: (env.Z2M_BASE_TOPIC ?? '').trim().replace(/\/+$/, ''),
    };
  }

  #settings() {
    return this.store.read('zigbee-settings', null);
  }

  status() {
    const saved = this.#settings();
    const { mode, username, password, baseTopic, url } = saved ?? this.defaults;
    return {
      source: saved ? 'settings' : 'environment',
      settings: { mode, url: mode === 'manual' ? url : '', username, hasPassword: Boolean(password), baseTopic },
      ...this.#status,
      ...this.diagnosis(),
    };
  }

  /** Only connection state and generic guidance for the AI, without addresses, credentials or device counts. */
  diagnosis() {
    const { phase, deviceCount, limited } = this.#status;
    const message = phase === 'ready'
      ? deviceCount === 0
        ? 'Zigbee2MQTT is connected. Its catalog contains no paired devices. Pair a device in Zigbee2MQTT.'
        : limited ? 'A Zigbee2MQTT catalog was received. The broker denied some state or availability subscriptions.'
          : 'A Zigbee2MQTT catalog was received.'
      : messages[phase];
    return { phase, message };
  }

  update(body) {
    const current = this.#settings() ?? this.defaults;
    const v = new Validator();
    const { mode, url = '', username = '', password, baseTopic = '' } = body ?? {};
    v.oneOf(mode, ['auto', 'manual', 'disabled'], 'Connection mode');
    let broker = '';
    if (mode === 'manual') {
      if (v.string(url, 'Broker URL', { max: 512 })) {
        try {
          const parsed = new URL(url.trim());
          if (!MQTT_PROTOCOLS.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
            || parsed.search || parsed.hash || (['mqtt:', 'mqtts:'].includes(parsed.protocol) && !['', '/'].includes(parsed.pathname))) throw new Error();
          broker = parsed.href;
        } catch {
          v.check(false, 'Enter a broker URL such as mqtt://192.168.1.20:1883 without embedded credentials or query parameters');
        }
      }
    }
    v.check(typeof username === 'string' && username.length <= 256, 'Username must be at most 256 characters');
    v.check(password == null || (typeof password === 'string' && password.length <= 1024), 'Password must be at most 1024 characters');
    v.check(typeof baseTopic === 'string' && baseTopic.length <= 256 && !/[+#\u0000-\u001f\u007f]/.test(baseTopic),
      'Base topic must be at most 256 characters without MQTT wildcards or control characters');
    v.throwIfInvalid();
    const sameAccount = broker === current.url && username === current.username;
    const topic = baseTopic.trim().replace(/\/+$/, '');
    this.store.write('zigbee-settings', {
      mode, url: broker, username: mode === 'manual' ? username : '',
      password: mode === 'manual' ? password === undefined && sameAccount ? current.password : password ?? '' : '',
      baseTopic: topic,
    });
    this.start({ clearDevices: current.mode !== mode || current.url !== broker || current.baseTopic !== topic });
    return this.status();
  }

  reset() {
    this.store.write('zigbee-settings', null);
    this.start({ clearDevices: true });
    return this.status();
  }

  /** Start or retry discovery using the saved settings. */
  start({ clearDevices = false } = {}) {
    this.close();
    if (clearDevices) this.registry.prune(PROVIDER_ID, new Set());
    const config = this.#settings() ?? this.defaults;
    if (config.mode === 'disabled') {
      this.#status = { phase: 'disabled' };
      return this.status();
    }
    const automatic = config.mode === 'auto';
    const brokers = automatic ? AUTO_BROKERS : [config.url];
    let best;

    const attempt = (index) => {
      this.close();
      const generation = this.#generation;
      if (index === brokers.length) {
        this.#status = best;
        this.#timer = setTimeout(() => this.start(), this.retryMs);
        this.#timer.unref?.();
        return;
      }

      const broker = brokers[index];
      this.#status = { phase: 'connecting', broker };
      const options = { reconnectPeriod: 5000, connectTimeout: 4500, resubscribe: false, queueQoSZero: false };
      if (!automatic && config.username) options.username = config.username;
      if (!automatic && config.password) options.password = config.password;
      let locked = false;
      this.#client = this.connect(broker, options);
      this.#client.on('error', (err) => {
        if (this.#generation !== generation) return;
        const auth = [4, 5, 134, 135].includes(err.code);
        const tls = /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(err.code));
        this.#status.phase = auth ? 'auth-error' : tls ? 'tls-error' : 'connection-error';
      });
      this.#client.on('close', () => {
        if (this.#generation === generation && !this.#status.phase.endsWith('error')) this.#status.phase = 'connection-error';
      });
      this.#provider = createZigbee2mqttProvider({
        client: this.#client,
        registry: this.registry,
        baseTopic: config.baseTopic,
        report: (state) => {
          if (this.#generation !== generation) return;
          Object.assign(this.#status, state);
          if (['ready', 'multiple-bridges'].includes(state.phase) || (state.phase === 'bridge-offline' && state.deviceCount !== undefined)) {
            locked = true;
            clearTimeout(this.#timer);
          }
        },
      });
      if (automatic && !locked) {
        this.#timer = setTimeout(() => {
          const score = { connecting: 0, 'connection-error': 0, 'tls-error': 1, 'auth-error': 2, waiting: 3, 'bridge-offline': 4, 'subscription-denied': 4 };
          if (!best || score[this.#status.phase] > score[best.phase]) best = this.#status;
          attempt(index + 1);
        }, this.probeMs);
        this.#timer.unref?.();
      }
    };

    attempt(0);
    return this.status();
  }

  close() {
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#provider?.close();
    this.#provider = null;
    this.#client?.end(true);
    this.#client = null;
  }
}
