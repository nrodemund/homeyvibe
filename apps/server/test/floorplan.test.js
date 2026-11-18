import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider, seedDemoConfig } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
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
