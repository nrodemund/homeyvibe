import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/store/json-store.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { DeviceHistory } from '../src/devices/history.js';
import { DeviceTimers } from '../src/devices/timers.js';
import { DAY, HOUR, MINUTE, openHistoryDatabase } from '../src/devices/history-db.js';
import { ActionApproval } from '../src/auth/action-approval.js';
import { AccessStore } from '../src/auth/access.js';
import { AuthService } from '../src/auth/auth.js';
import { ActionEngine, ActionStore } from '../src/config/actions.js';
import { FloorplanStore } from '../src/config/floorplan.js';
import { HistorySelection } from '../src/config/history-selection.js';
import { DeviceNotifications } from '../src/devices/notifications.js';
import { api, startApi } from './helpers.js';

const outlet = {
  id: 'test:one', provider: 'test', name: 'Outlet',
  capabilities: [
    { property: 'state', writable: true, readable: true, type: 'binary', valueOn: true, valueOff: false },
    { property: 'temperature', readable: true, type: 'numeric' },
  ],
  state: { state: false, temperature: 20 },
};
const hasSqlite = Boolean(process.getBuiltinModule?.('node:sqlite'));

test('SQLite keeps selected readings at each resolution and exact events across restarts', { skip: !hasSqlite }, (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'homeyvibe-history-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'history.sqlite');
  let now = 100 * DAY;
  let history = new DeviceHistory(() => now, openHistoryDatabase(path));
  history.setTracked(new Map([[outlet.id, new Set(['temperature'])]]));
  history.record(outlet, { temperature: 20 }, {});
  now += MINUTE;
  history.record(outlet, { temperature: 21, state: true }, { temperature: 20, state: false });
  now += MINUTE;
  history.record(outlet, { temperature: 21, state: true }, { temperature: 21, state: true });
  assert.deepEqual(history.get(outlet.id, 'temperature', '2h').map(([, value]) => value), [20, 21]);
  assert.equal(history.activity(outlet.id).length, 1);
  history.close();

  now += 31 * DAY;
  history = new DeviceHistory(() => now, openHistoryDatabase(path));
  try {
    assert.deepEqual(history.get(outlet.id, 'temperature', '30d'), []);
    assert.deepEqual(history.get(outlet.id, 'temperature', 'all').map(([, value]) => value), [21]);
    assert.equal(history.db.prepare('SELECT count(*) AS n FROM readings').get().n, 1);
    assert.deepEqual(history.activity(outlet.id).map((event) => event.value), [true]);
  } finally { history.close(); }
});

test('a click chart automatically starts persistence and hidden device history stays private', { skip: !hasSqlite }, async (t) => {
  const store = new JsonStore(null);
  const history = new DeviceHistory(Date.now, openHistoryDatabase(':memory:'));
  const registry = new DeviceRegistry({ history });
  registry.upsert(outlet);
  const floorplan = new FloorplanStore({ store });
  const historySelection = new HistorySelection({ store, registry, floorplan });
  const access = new AccessStore({ store });
  const ctx = await startApi(registry, { floorplan, access, historySelection });
  t.after(() => { ctx.close(); history.close(); });
  const path = '/api/devices/test%3Aone/history';
  const chart = { rooms: [], devices: [{ deviceId: outlet.id, position: [0, 1, 0],
    click: { mode: 'chart', property: 'temperature', range: '30d' } }] };
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/floorplan', { method: 'PUT', body: chart })).status, 200);
  assert.equal((await api(ctx.base, ctx.tokens.guest, path, { method: 'PUT', body: { property: 'temperature', enabled: false } })).status, 403);
  registry.updateState(outlet.id, { temperature: 23, state: true });
  const data = await (await api(ctx.base, ctx.tokens.guest, path + '?property=temperature&range=all')).json();
  assert.equal(data.points.at(-1)[1], 23);
  assert.equal(data.persistent, true);
  access.setUser(ctx.auth.authenticate(ctx.tokens.guest).id, { default: 'hidden' });
  assert.equal((await api(ctx.base, ctx.tokens.guest, path + '?property=temperature')).status, 404);
  assert.equal((await api(ctx.base, ctx.tokens.guest, '/api/devices/test%3Aone/activity')).status, 404);
});

test('timer edits replace the countdown and late shutoffs retry without duplicate commands', async (t) => {
  const store = new JsonStore(null);
  const registry = new DeviceRegistry();
  registry.upsert(outlet);
  const sent = [];
  registry.registerProvider({ id: 'test', command: async (_, value) => { sent.push(value.state); } });
  const id = outlet.id;
  let now = 100;
  let timers = new DeviceTimers({ store, registry, now: () => now });
  registry.timers = timers;
  const ctx = await startApi(registry);
  t.after(() => { ctx.close(); timers.close(); });
  const preset = { seconds: 4 * HOUR / 1000, values: { state: false } };
  const start = () => registry.command(id, { state: true }, preset);
  await start();
  now += MINUTE;
  await start();
  assert.equal(timers.get(id).expiresAt, now + 4 * HOUR);
  const path = '/api/devices/test%3Aone/timer';
  assert.equal((await api(ctx.base, ctx.tokens.guest, path, { method: 'PATCH', body: { seconds: 1 } })).status, 403);
  assert.equal((await api(ctx.base, ctx.tokens.member, path, { method: 'PATCH', body: { seconds: 60 } })).status, 200);
  timers.close();
  timers = new DeviceTimers({ store, registry, now: () => now });
  registry.timers = timers;
  assert.equal(timers.get(id).expiresAt, now + MINUTE);
  now += MINUTE;
  registry.setAvailable(id, false);
  await timers.tick();
  assert.equal(sent.length, 2);
  registry.setAvailable(id, true);
  now += 15_000;
  await Promise.all([timers.tick(), timers.tick()]);
  assert.deepEqual(sent, [true, true, false]);
  assert.equal(timers.get(id), null);
  await start();
  await registry.command(id, { state: false });
  assert.equal(timers.get(id), null);
});

test('protected actions reject copied approvals and nested or bearer execution', async (t) => {
  const registry = new DeviceRegistry();
  registry.upsert(outlet);
  let commands = 0;
  registry.registerProvider({ id: 'test', command: async () => { commands++; } });
  const store = new JsonStore(null);
  const actions = new ActionStore({ store });
  actions.create({ name: 'Heater', security: 'confirm', steps: [{ type: 'set', deviceId: outlet.id, values: { state: true } }] });
  actions.create({ name: 'Wrapper', steps: [
    { type: 'set', deviceId: outlet.id, values: { state: false } }, { type: 'run', actionId: 'heater' },
  ] });
  const engine = new ActionEngine({ actions, registry });
  const approval = new ActionApproval({ store });
  const ctx = await startApi(registry, { actions, engine, approval });
  t.after(() => ctx.close());
  const run = '/api/actions/heater/run';
  assert.equal((await api(ctx.base, ctx.tokens.admin, run, { method: 'POST' })).status, 403);
  assert.equal((await engine.run('wrapper')).ok, false);
  assert.equal(commands, 0);
  const session = (token, path, body) => api(ctx.base, null, path, { method: 'POST', body, headers: { cookie: `hv_session=${token}` } });
  const personalToken = ctx.auth.createAccessToken(ctx.auth.authenticate(ctx.tokens.admin).id, 'Personal').token;
  assert.equal((await session(personalToken, '/api/actions/heater/approval', {})).status, 403);
  const { nonce } = await (await session(ctx.tokens.admin, '/api/actions/heater/approval', {})).json();
  assert.equal((await session(ctx.tokens.member, run, { nonce })).status, 403);
  assert.equal((await session(ctx.tokens.admin, run, { nonce })).status, 200);
  assert.equal((await session(ctx.tokens.admin, run, { nonce })).status, 403);
  assert.equal(commands, 1);
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/actions/heater', { method: 'PATCH', body: { security: 'none' } })).status, 403);
});

test('passkey enrollment binds HTTPS, the account password, and a one-time challenge', async () => {
  const store = new JsonStore(null);
  const auth = new AuthService({ store });
  await auth.setup({ username: 'owner', password: 'test-password' });
  const { token, user } = await auth.login('owner', 'test-password');
  const approval = new ActionApproval({ store, auth });
  const request = { headers: { origin: 'https://home.example' } };
  await assert.rejects(approval.beginRegistration({ headers: { origin: 'http://home.example' } }, token, user, 'test-password'),
    /HTTPS/);
  await assert.rejects(approval.beginRegistration(request, token, user, 'wrong password'), { status: 401 });
  const { nonce, options } = await approval.beginRegistration(request, token, user, 'test-password');
  assert.equal(options.rp.id, 'home.example');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  await assert.rejects(approval.register(token, user, { nonce, response: {} }), /could not be verified/);
  await assert.rejects(approval.register(token, user, { nonce, response: {} }), /expired or is invalid/);
  assert.deepEqual(approval.keys(user), []);
});

test('push subscriptions reject arbitrary endpoints, observe selection and stop on logout', async () => {
  const store = new JsonStore(null);
  const auth = new AuthService({ store });
  const access = new AccessStore({ store });
  const registry = new DeviceRegistry();
  registry.upsert(outlet);
  await auth.setup({ username: 'admin', password: 'test-password' });
  const { token, user } = await auth.login('admin', 'test-password');
  const received = [];
  const push = {
    generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
    sendNotification: async (_, message) => received.push(JSON.parse(message)),
  };
  const notifications = new DeviceNotifications({ store, auth, registry, access, push });
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { auth: 'a'.repeat(22), p256dh: 'b'.repeat(87) } };
  assert.throws(() => notifications.update(token, user, { all: true, devices: [],
    subscription: { ...subscription, endpoint: 'https://127.0.0.1/' } }), /unsupported/);
  notifications.update(token, user, { all: false, devices: [outlet.id], subscription });
  registry.updateState(outlet.id, { state: true });
  assert.equal(received[0].title, outlet.name);
  auth.logout(token);
  registry.updateState(outlet.id, { state: false });
  assert.equal(received.length, 1);
});
