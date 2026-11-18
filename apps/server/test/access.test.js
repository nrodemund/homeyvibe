import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { ActionStore, ActionEngine } from '../src/config/actions.js';
import { FloorplanStore } from '../src/config/floorplan.js';
import { AccessStore, Policy, normalizeLimits } from '../src/auth/access.js';
import { startApi, api } from './helpers.js';

const RADIATOR = 'demo:living_room_radiator';
const LAMP = 'demo:living_room_lamp';
const SENSOR = 'demo:bathroom_sensor';
const BLIND = 'demo:bedroom_blind';

let ctx, env;

before(async () => {
  const registry = new DeviceRegistry();
  const demo = createDemoProvider({ registry, tickMs: 60_000 });
  const store = new JsonStore(null);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const engine = new ActionEngine({ actions, registry, sleep: async () => {} });
  const floorplan = new FloorplanStore({ store });
  const access = new AccessStore({ store });
  env = { registry, demo, pages, actions, engine, floorplan, access };
  ctx = await startApi(registry, { pages, actions, engine, floorplan, access });
  ctx.ids = Object.fromEntries(ctx.auth.listUsers().map((u) => [u.username, u.id]));
});
after(() => {
  env.demo.stop();
  ctx.close();
});

async function mcp(token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const put = (token, path, body) => api(ctx.base, token, path, { method: 'PUT', body });

// ---- policy ----------------------------------------------------------------------------

test('policy: the strictest layer wins and ranges narrow to their overlap', () => {
  const policy = new Policy([
    { default: 'control', devices: { a: { access: 'view' }, r: { access: 'control', ranges: { t: [16, 24] } } } },
    { default: 'view', devices: { r: { access: 'control', ranges: { t: [18, 22] } }, h: { access: 'hidden' } } },
  ]);
  assert.equal(policy.access('a'), 'view');
  assert.equal(policy.access('other'), 'view');
  assert.equal(policy.access('h'), 'hidden');
  assert.deepEqual(policy.ranges('r'), { t: [18, 22] });
  const radiator = { id: 'r', name: 'Radiator' };
  assert.doesNotThrow(() => policy.check(radiator, { t: 22 }));
  assert.throws(() => policy.check(radiator, { t: 23 }), /Radiator: t must be between 18 and 22/);
  assert.throws(() => policy.check({ id: 'a', name: 'Lamp' }, { state: 'ON' }), /view only/);
  assert.equal(new Policy([{ default: 'control', devices: {} }]).unrestricted, true);
});

test('limits are validated and only differences from the default are stored', () => {
  assert.deepEqual(normalizeLimits({ default: 'control', devices: { a: { access: 'control' }, b: { access: 'view' } } }),
    { default: 'control', devices: { b: { access: 'view' } } });
  assert.throws(() => normalizeLimits({ default: 'nope', devices: { a: { ranges: { t: [5, 1] } } } }),
    (err) => /default must be one of/.test(err.message) && /min <= max/.test(err.message));
});

// ---- people ---------------------------------------------------------------------------

test('a limited person sees only allowed devices and gets clear errors outside their range', async () => {
  const { member } = ctx.tokens;
  assert.equal((await put(member, `/api/access/users/${ctx.ids.member}`, { default: 'control' })).status, 403);
  assert.equal((await put(ctx.tokens.admin, `/api/access/users/${ctx.ids.admin}`, { default: 'view' })).status, 400);
  const saved = await put(ctx.tokens.admin, `/api/access/users/${ctx.ids.member}`, {
    default: 'control',
    devices: { [RADIATOR]: { access: 'control', ranges: { occupied_heating_setpoint: [18, 22] } }, [SENSOR]: { access: 'hidden' }, [BLIND]: { access: 'view' } },
  });
  assert.equal(saved.status, 200);

  const devices = await (await api(ctx.base, member, '/api/devices')).json();
  assert.ok(!devices.some((d) => d.id === SENSOR));
  const radiator = devices.find((d) => d.id === RADIATOR);
  assert.deepEqual(radiator.ranges, { occupied_heating_setpoint: [18, 22] });
  assert.equal(devices.find((d) => d.id === BLIND).access, 'view');
  assert.equal((await api(ctx.base, member, `/api/devices/${SENSOR}`)).status, 404);

  const set = (id, body) => api(ctx.base, member, `/api/devices/${id}/set`, { method: 'POST', body });
  const tooHot = await set(RADIATOR, { occupied_heating_setpoint: 25 });
  assert.equal(tooHot.status, 403);
  assert.match((await tooHot.json()).error, /must be between 18 and 22/);
  assert.equal((await set(RADIATOR, { occupied_heating_setpoint: 21.5 })).status, 202);
  assert.equal(env.registry.get(RADIATOR).state.occupied_heating_setpoint, 21.5);
  assert.equal((await set(BLIND, { position: 50 })).status, 403);
  assert.equal((await set(SENSOR, { temperature: 1 })).status, 404);
  // Admins are never limited.
  assert.equal((await api(ctx.base, ctx.tokens.admin, `/api/devices/${RADIATOR}/set`, { method: 'POST', body: { occupied_heating_setpoint: 30 } })).status, 202);
});

test('a limited person cannot run an action that goes beyond their limits', async () => {
  env.actions.create({ id: 'sauna', name: 'Sauna', steps: [{ type: 'set', deviceId: RADIATOR, values: { occupied_heating_setpoint: 28 } }] });
  const res = await api(ctx.base, ctx.tokens.member, '/api/actions/sauna/run', { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal(env.registry.get(RADIATOR).state.occupied_heating_setpoint, 30);
});

test('the event stream hides devices and resends the snapshot when limits change', async () => {
  const controller = new AbortController();
  const res = await api(ctx.base, ctx.tokens.member, '/api/events', { signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  const next = async (pattern) => {
    while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  };
  await next(/event: snapshot/);
  assert.ok(!text.includes(SENSOR));
  text = '';
  env.registry.updateState(SENSOR, { temperature: 30 });
  env.registry.updateState(LAMP, { brightness: 99 });
  await next(/demo:living_room_lamp/);
  assert.ok(!text.includes(SENSOR));
  text = '';
  await put(ctx.tokens.admin, `/api/access/users/${ctx.ids.member}`, { default: 'control' });
  await next(/event: snapshot[\s\S]*demo:bathroom_sensor/);
  controller.abort();
});

// ---- the AI user ------------------------------------------------------------------------

test('AI: its own limits apply on top of the person, for MCP tools and the context file', async () => {
  const saved = await put(ctx.tokens.admin, '/api/access/ai', {
    canControl: true,
    canConfigure: false,
    default: 'control',
    devices: { [RADIATOR]: { access: 'control', ranges: { occupied_heating_setpoint: [18, 22] } }, [BLIND]: { access: 'hidden' } },
  });
  assert.equal(saved.status, 200);
  assert.equal((await put(ctx.tokens.member, '/api/access/ai', { canControl: true })).status, 403);

  const admin = await mcp(ctx.tokens.admin);
  const overview = JSON.parse((await admin.callTool({ name: 'get_home_overview', arguments: {} })).content[0].text);
  assert.ok(!overview.devices.some((d) => d.id === BLIND));
  const radiator = overview.devices.find((d) => d.id === RADIATOR);
  assert.deepEqual(radiator.capabilities.find((c) => c.property === 'occupied_heating_setpoint').allowed, [18, 22]);
  assert.ok(!overview.you.permissions.includes('config:write'), 'canConfigure: false removes config:write even for an admin');
  assert.ok(overview.you.limits.some((l) => /may not change pages/.test(l)));

  const hot = await admin.callTool({ name: 'control_device', arguments: { deviceId: RADIATOR, values: { occupied_heating_setpoint: 26 } } });
  assert.equal(hot.isError, true);
  assert.match(hot.content[0].text, /between 18 and 22/);
  const ok = await admin.callTool({ name: 'control_device', arguments: { deviceId: RADIATOR, values: { occupied_heating_setpoint: 20 } } });
  assert.equal(ok.isError, undefined);
  const hidden = await admin.callTool({ name: 'control_device', arguments: { deviceId: BLIND, values: { position: 10 } } });
  assert.equal(hidden.isError, true);
  const sauna = await admin.callTool({ name: 'run_action', arguments: { actionId: 'sauna' } });
  assert.equal(sauna.isError, true);
  const page = await admin.callTool({ name: 'save_page', arguments: { page: { title: 'Nope', sections: [] } } });
  assert.equal(page.isError, true);
  await admin.close();

  const context = await (await api(ctx.base, ctx.tokens.admin, '/api/ai/context')).text();
  assert.ok(!context.includes(BLIND));
  assert.match(context, /"allowed": \[\s*18,\s*22\s*\]/);
});

test('AI: actions it writes must respect its limits, and floor plan edits keep devices it cannot see', async () => {
  await put(ctx.tokens.admin, '/api/access/ai', {
    canControl: true,
    canConfigure: true,
    default: 'control',
    devices: { [RADIATOR]: { access: 'control', ranges: { occupied_heating_setpoint: [18, 22] } }, [BLIND]: { access: 'hidden' } },
  });
  env.floorplan.replace({ rooms: [{ name: 'Bedroom', points: [[0, 0], [3, 0], [3, 3], [0, 3]] }], devices: [{ deviceId: BLIND, roomId: 'bedroom', position: [1, 1, 1] }] });

  const ai = await mcp(ctx.tokens.admin);
  const tooHot = await ai.callTool({ name: 'save_action', arguments: { action: { name: 'Warm', steps: [{ type: 'set', deviceId: RADIATOR, values: { occupied_heating_setpoint: 24 } }] } } });
  assert.equal(tooHot.isError, true);
  assert.match(tooHot.content[0].text, /between 18 and 22/);
  assert.equal(env.actions.get('warm'), null);

  const plan = await ai.callTool({ name: 'save_floorplan', arguments: { floorplan: { rooms: [{ name: 'Office', points: [[0, 0], [4, 0], [4, 4], [0, 4]] }], devices: [{ deviceId: LAMP, roomId: 'office', position: [1, 2, 1] }] } } });
  assert.equal(plan.isError, undefined);
  await ai.close();
  const stored = env.floorplan.get();
  assert.deepEqual(stored.devices.map((d) => d.deviceId).sort(), [BLIND, LAMP].sort());
  assert.equal(stored.devices.find((d) => d.deviceId === BLIND).roomId, null);
});

test('AI: with control switched off it can only look', async () => {
  await put(ctx.tokens.admin, '/api/access/ai', { canControl: false, canConfigure: false, default: 'control', devices: {} });
  const ai = await mcp(ctx.tokens.admin);
  const res = await ai.callTool({ name: 'control_device', arguments: { deviceId: LAMP, values: { state: 'OFF' } } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /HomeyVibe AI is not allowed/);
  await ai.close();
  const all = await (await api(ctx.base, ctx.tokens.admin, '/api/access')).json();
  assert.equal(all.ai.canControl, false);
});
