import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { ActionStore, ActionEngine, compare } from '../src/config/actions.js';
import { startApi, api } from './helpers.js';

function setup() {
  const registry = new DeviceRegistry();
  const demo = createDemoProvider({ registry, tickMs: 60_000 });
  const store = new JsonStore(null);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const engine = new ActionEngine({ actions, registry, sleep: async () => {} });
  return { registry, demo, pages, actions, engine };
}

// ---- pages ------------------------------------------------------------------------

test('pages: create with generated id, update, list in order, delete', () => {
  const { pages, demo } = setup();
  const living = pages.create({
    title: 'Living room',
    icon: '🛋️',
    sections: [{ title: 'Lights', items: [{ type: 'device', deviceId: 'demo:living_room_lamp', properties: ['state', 'brightness'] }] }],
  });
  assert.equal(living.id, 'living-room');
  assert.equal(living.layout, 'grid');
  assert.equal(living.order, 0);
  const dup = pages.create({ title: 'Living room' });
  assert.equal(dup.id, 'living-room-2');
  pages.update('living-room-2', { title: 'Bedroom', order: -1 });
  assert.deepEqual(pages.list().map((p) => p.title), ['Bedroom', 'Living room']);
  pages.delete('living-room');
  assert.equal(pages.list().length, 1);
  assert.throws(() => pages.delete('living-room'), { status: 404 });
  demo.stop();
});

test('pages: validation reports every problem at once', () => {
  const { pages, demo } = setup();
  assert.throws(
    () => pages.create({ title: '', layout: 'cube', sections: [{ items: [{ type: 'widget' }, { type: 'device' }] }] }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /title must be/);
      assert.match(err.message, /layout must be one of grid, list, 3d/);
      assert.match(err.message, /items\[0\]\.type must be one of device, action/);
      assert.match(err.message, /items\[1\]\.deviceId must be/);
      return true;
    },
  );
  demo.stop();
});

// ---- actions ----------------------------------------------------------------------

test('actions: validation of steps and triggers', () => {
  const { actions, demo } = setup();
  assert.throws(() => actions.create({ name: 'Empty', steps: [] }), /at least one step/);
  assert.throws(
    () => actions.create({
      name: 'Bad',
      steps: [{ type: 'set', deviceId: 'x', values: {} }, { type: 'delay', seconds: 99999 }, { type: 'run', actionId: 'bad' }],
      triggers: [{ type: 'time', at: '25:00' }, { type: 'state', deviceId: 'x', property: 'temperature', op: 'gt', value: 'warm' }],
    }),
    (err) => {
      assert.match(err.message, /steps\[0\]\.values must be an object/);
      assert.match(err.message, /steps\[1\]\.seconds/);
      assert.match(err.message, /steps\[2\] cannot run its own action/);
      assert.match(err.message, /triggers\[0\]\.at must be HH:MM/);
      assert.match(err.message, /triggers\[1\]\.value must be a number/);
      return true;
    },
  );
  demo.stop();
});

test('engine: runs set, delay and nested run steps', async () => {
  const { registry, actions, engine, demo } = setup();
  actions.create({ name: 'Blinds down', steps: [{ type: 'set', deviceId: 'demo:bedroom_blind', values: { position: 0 } }] });
  actions.create({
    name: 'Movie night',
    steps: [
      { type: 'set', deviceId: 'demo:living_room_lamp', values: { state: 'ON', brightness: 40 } },
      { type: 'delay', seconds: 1 },
      { type: 'run', actionId: 'blinds-down' },
    ],
  });
  const runs = [];
  engine.on('run', (r) => runs.push(r));
  const result = await engine.run('movie-night', { by: 'user:test' });
  assert.equal(result.ok, true);
  assert.equal(registry.get('demo:living_room_lamp').state.brightness, 40);
  assert.equal(registry.get('demo:bedroom_blind').state.position, 0);
  assert.deepEqual(runs.map((r) => [r.actionId, r.by]), [['movie-night', 'user:test']]);
  demo.stop();
});

test('engine: a failing step reports the error instead of throwing', async () => {
  const { actions, engine, demo } = setup();
  actions.create({ name: 'Broken', steps: [{ type: 'set', deviceId: 'demo:living_room_lamp', values: { brightness: 9999 } }] });
  const result = await engine.run('broken');
  assert.equal(result.ok, false);
  assert.match(result.error, /<= 254/);
  await assert.rejects(engine.run('missing'), { status: 404 });
  demo.stop();
});

test('engine: state triggers fire on matching changes, respect enabled and cooldown', async () => {
  const { registry, actions, engine, demo } = setup();
  actions.create({
    name: 'Fan on when humid',
    steps: [{ type: 'set', deviceId: 'demo:hallway_switch', values: { state_right: 'ON' } }],
    triggers: [{ type: 'state', deviceId: 'demo:bathroom_sensor', property: 'humidity', op: 'gt', value: 70 }],
  });
  registry.updateState('demo:hallway_switch', { state_right: 'OFF' });
  engine.start({ tickMs: 60_000 });
  const ran = new Promise((resolve) => engine.once('run', resolve));
  registry.updateState('demo:bathroom_sensor', { humidity: 60 });
  registry.updateState('demo:bathroom_sensor', { humidity: 75 });
  assert.equal((await ran).by, 'trigger:state');
  assert.equal(registry.get('demo:hallway_switch').state.state_right, 'ON');

  let count = 0;
  engine.on('run', () => count++);
  registry.updateState('demo:bathroom_sensor', { humidity: 80 }); // within cooldown
  actions.update('fan-on-when-humid', { enabled: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 0);
  engine.stop();
  demo.stop();
});

test('engine: time triggers fire once in their minute on the listed days', () => {
  const { actions, registry } = setup();
  let now = new Date('2026-11-16T07:30:10'); // a Monday, local time
  const engine = new ActionEngine({ actions, registry, now: () => now, sleep: async () => {} });
  actions.create({
    name: 'Wake up',
    steps: [{ type: 'set', deviceId: 'demo:bedroom_blind', values: { position: 100 } }],
    triggers: [{ type: 'time', at: '07:30', days: ['mon', 'tue'] }],
  });
  actions.create({
    name: 'Weekend',
    steps: [{ type: 'set', deviceId: 'demo:bedroom_blind', values: { position: 50 } }],
    triggers: [{ type: 'time', at: '07:30', days: ['sat'] }],
  });
  const fired = [];
  const runSpy = engine.run.bind(engine);
  engine.run = (id, opts) => {
    fired.push(id);
    return runSpy(id, opts);
  };
  engine.tick();
  now = new Date('2026-11-16T07:30:40');
  engine.tick();
  assert.deepEqual(fired, ['wake-up']);
});

test('compare operators', () => {
  assert.ok(compare(5, 'gt', 4));
  assert.ok(!compare('5', 'gt', 4));
  assert.ok(compare('ON', 'eq', 'ON'));
  assert.ok(compare('ON', 'ne', 'OFF'));
  assert.ok(compare(3, 'lte', 3));
  assert.ok(compare(undefined, 'changed'));
});

// ---- API ------------------------------------------------------------------------------

let ctx, env;
before(async () => {
  env = setup();
  ctx = await startApi(env.registry, { pages: env.pages, actions: env.actions, engine: env.engine });
});
after(() => {
  env.demo.stop();
  ctx.close();
});

test('API: admins write pages and actions, members run actions, guests only read', async () => {
  const page = { title: 'Kitchen', sections: [{ items: [{ type: 'device', deviceId: 'demo:hallway_switch' }] }] };
  assert.equal((await api(ctx.base, ctx.tokens.member, '/api/pages', { method: 'POST', body: page })).status, 403);
  const created = await api(ctx.base, ctx.tokens.admin, '/api/pages', { method: 'POST', body: page });
  assert.equal(created.status, 201);
  assert.equal((await api(ctx.base, ctx.tokens.guest, '/api/pages/kitchen')).status, 200);
  const patched = await api(ctx.base, ctx.tokens.admin, '/api/pages/kitchen', { method: 'PATCH', body: { icon: '🍳' } });
  assert.equal((await patched.json()).icon, '🍳');

  const action = { name: 'All off', steps: [{ type: 'set', deviceId: 'demo:hallway_switch', values: { state_left: 'OFF', state_right: 'OFF' } }] };
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/actions', { method: 'POST', body: action })).status, 201);
  assert.equal((await api(ctx.base, ctx.tokens.guest, '/api/actions/all-off/run', { method: 'POST' })).status, 403);
  const run = await api(ctx.base, ctx.tokens.member, '/api/actions/all-off/run', { method: 'POST' });
  const result = await run.json();
  assert.equal(result.ok, true);
  assert.equal(result.by, 'user:member');

  const bad = await api(ctx.base, ctx.tokens.admin, '/api/actions', { method: 'POST', body: { name: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/pages/kitchen', { method: 'DELETE' })).status, 200);
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/pages/kitchen', { method: 'DELETE' })).status, 404);
});
