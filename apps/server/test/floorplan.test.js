import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { DeviceHistory } from '../src/devices/history.js';
import { createDemoProvider, seedDemoConfig } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { AccessStore } from '../src/auth/access.js';
import { ActionStore, ActionEngine } from '../src/config/actions.js';
import { FloorplanStore, normalizeFloorplan, polygonArea } from '../src/config/floorplan.js';
import { importConfig } from '../src/ai/importer.js';
import { buildContext } from '../src/ai/context.js';
import { startApi, api } from './helpers.js';

const square = (x, z, size = 4) => [[x, z], [x + size, z], [x + size, z + size], [x, z + size]];

let ctx, env;

before(async () => {
  const registry = new DeviceRegistry();
  const demo = createDemoProvider({ registry, tickMs: 60_000 });
  const store = new JsonStore(null);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const engine = new ActionEngine({ actions, registry, sleep: async () => {} });
  const floorplan = new FloorplanStore({ store });
  env = { registry, demo, pages, actions, engine, floorplan };
  ctx = await startApi(registry, { pages, actions, engine, floorplan });
});
after(() => {
  env.demo.stop();
  ctx.close();
});

test('normalizeFloorplan fills defaults and generates room ids', () => {
  const plan = normalizeFloorplan({
    rooms: [{ name: 'Living room', points: square(0, 0) }],
    devices: [{ deviceId: 'demo:living_room_lamp', roomId: 'living-room', position: [1, 2.2, 1.00001] }],
  });
  assert.deepEqual(plan.rooms[0], { id: 'living-room', name: 'Living room', floor: 0, height: 2.5, points: square(0, 0) });
  assert.deepEqual(plan.devices[0].position, [1, 2.2, 1]);
  assert.equal(polygonArea(square(0, 0)), 16);
});

test('normalizeFloorplan reports every problem at once', () => {
  assert.throws(() => normalizeFloorplan({
    rooms: [
      { name: 'A', points: [[0, 0], [1, 0]] },
      { name: 'Same', points: square(0, 0) },
      { name: 'Same', points: square(5, 0) },
      { name: 'Tiny', points: [[0, 0], [0.1, 0], [0.1, 0.1]] },
      { name: 'Far', points: [[0, 0], [9999, 0], [0, 1]] },
    ],
    devices: [
      { deviceId: 'x', roomId: 'nowhere', position: [0, 0, 0] },
      { deviceId: 'x', position: [0, -1, 0] },
    ],
  }), (err) => {
    for (const re of [/rooms\[0\]\.points must list 3 to 64/, /id same is used twice/, /too small/, /at most 500/,
      /roomId nowhere is not a room/, /x is placed twice/, /y \(height\) at least 0/]) assert.match(err.message, re);
    return true;
  });
  assert.throws(() => normalizeFloorplan([]), /must be an object/);
});

test('API: everyone reads the plan, only config:write replaces it, and changes are streamed', async () => {
  assert.deepEqual(await (await api(ctx.base, ctx.tokens.guest, '/api/floorplan')).json(), { rooms: [], devices: [] });
  const body = { rooms: [{ name: 'Kitchen', points: square(0, 0, 3) }], devices: [] };
  assert.equal((await api(ctx.base, ctx.tokens.member, '/api/floorplan', { method: 'PUT', body })).status, 403);
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/floorplan', { method: 'PUT', body: { rooms: 'x' } })).status, 400);

  const controller = new AbortController();
  const events = await api(ctx.base, ctx.tokens.guest, '/api/events', { signal: controller.signal });
  const reader = events.body.getReader();
  const saved = await api(ctx.base, ctx.tokens.admin, '/api/floorplan', { method: 'PUT', body });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).rooms[0].id, 'kitchen');

  let text = '';
  while (!text.includes('event: floorplan')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.match(text, /"name":"Kitchen"/);
});

test('import: a floorplan in the bundle is validated against real devices, then replaces the plan', () => {
  const { pages, actions, registry, floorplan } = env;
  assert.throws(() => importConfig({
    bundle: { floorplan: { rooms: [], devices: [{ deviceId: 'demo:ghost', position: [0, 1, 0] }] } },
    pages, actions, registry, floorplan,
  }), /floorplan\.devices\[0\]: unknown device demo:ghost/);
  assert.equal(floorplan.get().rooms[0].name, 'Kitchen');

  const r = importConfig({
    bundle: { floorplan: { rooms: [{ name: 'Office', points: square(0, 0) }], devices: [{ deviceId: 'demo:living_room_lamp', roomId: 'office', position: [2, 2, 2] }] } },
    pages, actions, registry, floorplan,
  });
  assert.deepEqual(r.floorplan, { rooms: 1, devices: 1 });
  assert.equal(floorplan.get().rooms[0].id, 'office');
  assert.throws(() => importConfig({ bundle: { floorplan: { rooms: [] } }, pages, actions, registry }), /does not store a floor plan/);
});

test('MCP: save_floorplan and the overview include the plan; guests cannot save it', async () => {
  const connect = async (token) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  };
  const admin = await connect(ctx.tokens.admin);
  const plan = { rooms: [{ name: 'Studio', points: square(0, 0, 6) }], devices: [{ deviceId: 'demo:bathroom_sensor', roomId: 'studio', position: [1, 1.5, 1] }] };
  const saved = await admin.callTool({ name: 'save_floorplan', arguments: { floorplan: plan } });
  assert.equal(saved.isError, undefined);
  assert.match(saved.content[0].text, /1 rooms, 1 placed devices/);
  const overview = JSON.parse((await admin.callTool({ name: 'get_home_overview', arguments: {} })).content[0].text);
  assert.equal(overview.floorplan.rooms[0].name, 'Studio');
  await admin.close();

  const guest = await connect(ctx.tokens.guest);
  const denied = await guest.callTool({ name: 'save_floorplan', arguments: { floorplan: plan } });
  assert.equal(denied.isError, true);
  await guest.close();
});

test('context file documents the floor plan format and includes the current plan', () => {
  const { registry, pages, actions, floorplan } = env;
  const md = buildContext({ registry, pages, actions, floorplan });
  assert.match(md, /## Floor plan format/);
  assert.match(md, /## Floor plan \(1 rooms\)/);
  assert.match(md, /"Studio"/);
});

test('demo seed adds a floor plan and a 3D page once', () => {
  const store = new JsonStore(null);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const floorplan = new FloorplanStore({ store });
  seedDemoConfig({ pages, actions, floorplan });
  seedDemoConfig({ pages, actions, floorplan });
  assert.equal(floorplan.get().rooms.length, 4);
  assert.deepEqual(pages.list().filter((p) => p.layout === '3d').map((p) => p.id), ['home-3d']);
  // Every demo device placement refers to a room in the plan.
  const rooms = new Set(floorplan.get().rooms.map((r) => r.id));
  assert.ok(floorplan.get().devices.every((d) => rooms.has(d.roomId)));
});

test('room openings, finishes and device presets validate together', () => {
  const input = {
    rooms: [{ name: 'Room', points: square(0, 0), style: { floorColor: '#654321', edges: true }, openings: [
      { type: 'window', edge: 0, offset: 2, width: 1, height: 1 },
      { type: 'door', edge: 1, offset: 1, width: 0.9, height: 2 },
    ] }],
    devices: [{ deviceId: 'gong', position: [1, 1, 1], roomId: 'room', display: { mode: 'status', property: 'alarm' },
      click: { mode: 'command', values: { melody: '5', duration: 3, volume: 'high', alarm: true } },
      light: { enabled: false, strength: 0.4, color: '#ffc977' },
    }],
  };
  const plan = normalizeFloorplan(input);
  assert.deepEqual(plan.rooms[0].style, input.rooms[0].style);
  assert.equal(plan.rooms[0].openings[0].bottom, 0.8);
  assert.equal(plan.rooms[0].openings[1].bottom, 0);
  assert.deepEqual(plan.devices[0].click, input.devices[0].click);
  assert.deepEqual(normalizeFloorplan(plan), plan);

  input.rooms[0].style.floorColor = 'invalid';
  input.rooms[0].openings.push({ type: 'door', edge: 1, offset: 1, width: 5, height: 3 });
  input.devices[0].display = { mode: 'chart', min: 40, max: 20 };
  input.devices[0].light.strength = 3;
  assert.throws(() => normalizeFloorplan(input), (err) => {
    for (const re of [/floorColor/, /extends beyond the wall/, /extends above/, /overlaps another opening/, /above min/, /light.strength/]) {
      assert.match(err.message, re);
    }
    return true;
  });
});

test('preset storage, actions and history respect device limits and role permissions', async (t) => {
  const registry = new DeviceRegistry();
  const demo = createDemoProvider({ registry, tickMs: 60_000 });
  const store = new JsonStore(null);
  const floorplan = new FloorplanStore({ store });
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const access = new AccessStore({ store });
  const ctx = await startApi(registry, { pages, actions, floorplan, access });
  t.after(() => { demo.stop(); ctx.close(); });
  const lamp = 'demo:living_room_lamp';
  const sensor = 'demo:bathroom_sensor';
  const member = ctx.auth.authenticate(ctx.tokens.member);
  const plan = {
    rooms: [{ name: 'Room', points: square(0, 0) }],
    devices: [
      { deviceId: lamp, roomId: 'room', position: [1, 2, 1], click: { mode: 'command', values: { brightness: 100 } } },
      { deviceId: sensor, roomId: 'room', position: [2, 1, 2], display: { mode: 'chart', property: 'temperature' } },
    ],
  };
  const write = (token, body) => api(ctx.base, token, '/api/floorplan', { method: 'PUT', body });
  assert.equal((await write(ctx.tokens.guest, plan)).status, 403);
  const invalid = structuredClone(plan);
  invalid.devices[0].click.values.brightness = 999;
  assert.match((await (await write(ctx.tokens.admin, invalid)).json()).error, /brightness/);
  assert.equal(floorplan.get().rooms.length, 0);

  access.setUser(member.id, { devices: { [lamp]: { access: 'view' }, [sensor]: { access: 'hidden' } } });
  const eventRequest = new AbortController();
  const stream = await api(ctx.base, ctx.tokens.member, '/api/events', { signal: eventRequest.signal });
  const reader = stream.body.getReader();
  t.after(() => eventRequest.abort());
  const saved = await write(ctx.tokens.admin, plan);
  assert.equal(saved.status, 200);
  let events = '';
  while (!events.includes('event: floorplan')) events += new TextDecoder().decode((await reader.read()).value);
  const update = JSON.parse(events.split('event: floorplan\ndata: ')[1].split('\n')[0]);
  assert.equal(update.devices.length, 1);
  assert.equal(update.devices[0].click, undefined);
  eventRequest.abort();

  const guest = await (await api(ctx.base, ctx.tokens.guest, '/api/floorplan')).json();
  assert.equal(guest.devices[0].click, undefined);
  const historyPath = `/api/devices/${encodeURIComponent(sensor)}/history?property=temperature`;
  registry.updateState(sensor, { temperature: 21.8 });
  assert.equal((await api(ctx.base, null, historyPath)).status, 401);
  assert.equal((await api(ctx.base, ctx.tokens.member, historyPath)).status, 404);
  const history = await (await api(ctx.base, ctx.tokens.guest, historyPath)).json();
  assert.equal(history.points.at(-1)[1], 21.8);
  assert.equal((await api(ctx.base, ctx.tokens.admin, historyPath.replace('temperature', 'unknown'))).status, 400);
  assert.equal((await api(ctx.base, ctx.tokens.member, `/api/devices/${lamp}/set`, { method: 'POST', body: { brightness: 100 } })).status, 403);

  access.setAi({ canConfigure: true, canControl: false });
  const proposed = structuredClone(plan);
  proposed.devices[0].click.values.brightness = 1;
  const ai = (floorplan) => api(ctx.base, ctx.tokens.admin, '/api/ai/tools/save_floorplan', { method: 'POST', body: { floorplan } });
  const refusal = await (await ai(proposed)).json();
  assert.equal(refusal.ok, false);
  assert.match(refusal.text, /needs device control permission/);
  delete proposed.devices[0].click;
  assert.equal((await (await ai(proposed)).json()).ok, true);
  assert.equal(floorplan.get().devices[0].click.values.brightness, 100);
  const limitedAiContext = await (await api(ctx.base, ctx.tokens.admin, '/api/ai/context')).text();
  assert.doesNotMatch(limitedAiContext, /"click":/);

  const toggle = actions.create({ name: 'Toggle lamp', steps: [{ type: 'set', deviceId: lamp, values: { state: 'ON' } }] });
  const nested = actions.create({ name: 'Run lamp action', steps: [{ type: 'run', actionId: toggle.id }] });
  access.setAi({ canConfigure: true, canControl: true, devices: { [lamp]: { access: 'view' } } });
  proposed.devices[1].click = { mode: 'action', actionId: nested.id };
  const deniedAction = await (await ai(proposed)).json();
  assert.equal(deniedAction.ok, false);
  assert.match(deniedAction.text, /view only/);
});

test('numeric history retains the most recent value per bucket and expires old samples', () => {
  let now = 100;
  const history = new DeviceHistory(() => now);
  const device = { id: 'sensor', capabilities: [{ type: 'numeric', readable: true, property: 'temperature' }] };
  history.record(device, { temperature: 20 });
  now = 300;
  history.record(device, { temperature: 21 });
  now = 300_100;
  history.record(device, { temperature: 22, unknown: 50 });
  assert.deepEqual(history.get('sensor', 'temperature'), [[300, 21], [300_100, 22]]);
  assert.deepEqual(history.get('sensor', 'unknown'), []);
  now += 86_400_000 + 1;
  assert.deepEqual(history.get('sensor', 'temperature'), []);
});

test('page ordering is atomic and only one page is the startup page', async (t) => {
  const pages = new PageStore({ store: new JsonStore(null) });
  pages.create({ title: 'First', startPage: true });
  pages.create({ title: 'Second' });
  pages.update('second', { startPage: true });
  const ctx = await startApi(new DeviceRegistry(), { pages });
  t.after(() => ctx.close());
  const reorder = (token, ids) => api(ctx.base, token, '/api/pages/order', { method: 'PUT', body: { ids } });
  assert.equal((await reorder(ctx.tokens.member, ['second', 'first'])).status, 403);
  assert.equal((await reorder(ctx.tokens.admin, ['first', 'first'])).status, 409);
  assert.deepEqual(pages.list().map((page) => page.id), ['first', 'second']);
  assert.deepEqual((await (await reorder(ctx.tokens.admin, ['second', 'first'])).json()).map((page) => page.id), ['second', 'first']);
  assert.deepEqual(pages.list().filter((page) => page.startPage).map((page) => page.id), ['second']);
  pages.delete('second');
  assert.equal(pages.list().some((page) => page.startPage), false);
});
