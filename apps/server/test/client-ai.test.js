import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { ActionStore, ActionEngine } from '../src/config/actions.js';
import { FloorplanStore } from '../src/config/floorplan.js';
import { AccessStore } from '../src/auth/access.js';
import { DEFAULT_MODEL } from '../src/ai/chat.js';
import { startApi, api } from './helpers.js';

// The model runs on the client (browser, desktop); the server only describes and runs the tools.

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
  env = { registry, demo, access };
  ctx = await startApi(registry, { pages, actions, engine, floorplan, access });
});
after(() => {
  env.demo.stop();
  ctx.close();
});

const run = (token, name, input) => api(ctx.base, token, `/api/ai/tools/${name}`, { method: 'POST', body: input });

test('GET /api/ai/tools describes the model, system prompt and tools; no API key needed on the server', async () => {
  const res = await api(ctx.base, ctx.tokens.member, '/api/ai/tools');
  assert.equal(res.status, 200);
  const kit = await res.json();
  assert.equal(kit.model, DEFAULT_MODEL);
  assert.equal(kit.system[0].cache_control.type, 'ephemeral');
  assert.match(kit.system[1].text, /acting for member/);
  const control = kit.tools.find((t) => t.name === 'control_device');
  assert.equal(control.title, 'Control a device');
  assert.equal(control.input_schema.type, 'object');
  assert.equal(control.input_schema.$schema, undefined);
  assert.equal((await api(ctx.base, null, '/api/ai/tools')).status, 401);
});

test('POST /api/ai/tools/:name runs a tool with validation, permissions and AI limits', async () => {
  const ok = await (await run(ctx.tokens.member, 'control_device', { deviceId: 'demo:living_room_lamp', values: { state: 'OFF' } })).json();
  assert.deepEqual(ok, { ok: true, text: 'Sent {"state":"OFF"} to Living room lamp.' });
  assert.equal(env.registry.get('demo:living_room_lamp').state.state, 'OFF');

  const invalid = await (await run(ctx.tokens.member, 'control_device', { deviceId: 5 })).json();
  assert.equal(invalid.ok, false);
  assert.match(invalid.text, /Invalid input/);

  const guest = await (await run(ctx.tokens.guest, 'control_device', { deviceId: 'demo:living_room_lamp', values: { state: 'ON' } })).json();
  assert.equal(guest.ok, false);
  assert.match(guest.text, /not allowed/);

  env.access.setAi({ default: 'control', devices: { 'demo:living_room_radiator': { access: 'control', ranges: { occupied_heating_setpoint: [18, 22] } } } });
  const hot = await (await run(ctx.tokens.admin, 'control_device', { deviceId: 'demo:living_room_radiator', values: { occupied_heating_setpoint: 25 } })).json();
  assert.equal(hot.ok, false);
  assert.match(hot.text, /between 18 and 22/);

  const unknown = await (await run(ctx.tokens.admin, 'format_disk', {})).json();
  assert.deepEqual(unknown, { ok: false, text: 'Unknown tool format_disk' });
});
