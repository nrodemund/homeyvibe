import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DeviceHistory } from './devices/history.js';
import { openHistoryDatabase } from './devices/history-db.js';
import { HistorySelection } from './config/history-selection.js';
import { DeviceTimers } from './devices/timers.js';
import { ActionApproval } from './auth/action-approval.js';
import { DeviceNotifications } from './devices/notifications.js';
import { DeviceRegistry } from './devices/registry.js';
import { ZigbeeConnection } from './providers/zigbee2mqtt/connection.js';
import { createDemoProvider, seedDemoConfig } from './providers/demo/index.js';
import { createApiHandler } from './http/api.js';
import { JsonStore } from './store/json-store.js';
import { AuthService } from './auth/auth.js';
import { PageStore } from './config/pages.js';
import { ActionStore, ActionEngine } from './config/actions.js';
import { FloorplanStore } from './config/floorplan.js';
import { AccessStore } from './auth/access.js';
import { AiSettings, ChatService } from './ai/chat.js';

const port = Number(process.env.PORT ?? 8080);
const demo = process.env.HOMEYVIBE_DEMO === '1';

const dataDir = process.env.HOMEYVIBE_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url));

const store = new JsonStore(dataDir);
let db;
try { db = openHistoryDatabase(join(dataDir, 'history.sqlite')); } catch (err) {
  console.warn('Device history is in memory:', err.message);
}
const registry = new DeviceRegistry({ history: new DeviceHistory(Date.now, db) });
registry.timers = new DeviceTimers({ store, registry });
const auth = new AuthService({ store });
const approval = new ActionApproval({ store, auth });
const pages = new PageStore({ store });
const actions = new ActionStore({ store });
const floorplan = new FloorplanStore({ store });
const historySelection = new HistorySelection({ store, floorplan, registry });
const access = new AccessStore({ store });
const notifications = new DeviceNotifications({ store, registry, auth, access });
const engine = new ActionEngine({ actions, registry });
engine.start();
const aiSettings = new AiSettings({ store });
const zigbee = new ZigbeeConnection({ registry, store });
const chat = new ChatService({ settings: aiSettings, registry, pages, actions, engine, floorplan, access, zigbee });
engine.on('run', (r) => console.log(`Action ${r.actionId} by ${r.by}: ${r.ok ? 'ok' : r.error}`));

if (demo) {
  createDemoProvider({ registry });
  seedDemoConfig({ pages, actions, floorplan });
  console.log('Demo mode: simulated devices, example pages and actions loaded');
}

zigbee.start();

createServer(createApiHandler({
  registry, auth, pages, actions, engine, aiSettings, chat, floorplan, access, zigbee, historySelection, approval, notifications,
})).listen(port, () =>
  console.log(
    `HomeyVibe server on :${port}` + (auth.needsSetup() ? ' (no users yet: open the web app to create the first admin)' : ''),
  ),
);
