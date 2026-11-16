import { createServer } from 'node:http';
import mqtt from 'mqtt';
import { DeviceRegistry } from './devices/registry.js';
import { createZigbee2mqttProvider } from './providers/zigbee2mqtt/index.js';
import { createDemoProvider, seedDemoConfig } from './providers/demo/index.js';
import { createApiHandler } from './http/api.js';
import { JsonStore } from './store/json-store.js';
import { AuthService } from './auth/auth.js';
import { PageStore } from './config/pages.js';
import { ActionStore, ActionEngine } from './config/actions.js';
import { FloorplanStore } from './config/floorplan.js';
import { AiSettings, ChatService } from './ai/chat.js';

const port = Number(process.env.PORT ?? 8080);
const demo = process.env.HOMEYVIBE_DEMO === '1';
const mqttUrl = process.env.MQTT_URL ?? (demo ? null : 'mqtt://localhost:1883');
const z2mBaseTopic = process.env.Z2M_BASE_TOPIC ?? 'zigbee2mqtt';

const dataDir = process.env.HOMEYVIBE_DATA_DIR ?? new URL('../data', import.meta.url).pathname;

const registry = new DeviceRegistry();
const store = new JsonStore(dataDir);
const auth = new AuthService({ store });
const pages = new PageStore({ store });
const actions = new ActionStore({ store });
const floorplan = new FloorplanStore({ store });
const engine = new ActionEngine({ actions, registry });
engine.start();
const aiSettings = new AiSettings({ store });
const chat = new ChatService({ settings: aiSettings, registry, pages, actions, engine, floorplan });
engine.on('run', (r) => console.log(`Action ${r.actionId} by ${r.by}: ${r.ok ? 'ok' : r.error}`));

if (demo) {
  createDemoProvider({ registry });
  seedDemoConfig({ pages, actions, floorplan });
  console.log('Demo mode: simulated devices, example pages and actions loaded');
}


if (mqttUrl) {
  const client = mqtt.connect(mqttUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 5000,
  });
  client.on('connect', () => console.log(`MQTT connected: ${mqttUrl}`));
  client.on('error', (err) => console.warn(`MQTT error: ${err.message}`));
  createZigbee2mqttProvider({ client, registry, baseTopic: z2mBaseTopic, log: console.log });
}

createServer(createApiHandler({ registry, auth, pages, actions, engine, aiSettings, chat, floorplan })).listen(port, () =>
  console.log(
    `HomeyVibe server on :${port}` + (auth.needsSetup() ? ' (no users yet: open the web app to create the first admin)' : ''),
  ),
);
