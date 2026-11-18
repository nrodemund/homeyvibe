import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createZigbee2mqttProvider } from '../src/providers/zigbee2mqtt/index.js';
import { FakeMqttClient, bridgeDevices, startApi, api } from './helpers.js';

let ctx, client;

before(async () => {
  client = new FakeMqttClient();
  const registry = new DeviceRegistry();
  createZigbee2mqttProvider({ client, registry });
  client.receive('zigbee2mqtt/bridge/devices', bridgeDevices);
  ctx = await startApi(registry);
});
after(() => ctx.close());

test('GET /api/health is public', async () => {
  const res = await api(ctx.base, null, '/api/health');
  assert.deepEqual(await res.json(), { ok: true, name: 'homeyvibe' });
});

test('GET /api/devices and /api/devices/:id', async () => {
  const list = await (await api(ctx.base, ctx.tokens.guest, '/api/devices')).json();
  assert.equal(list.length, 3);
  const one = await api(ctx.base, ctx.tokens.guest, `/api/devices/${encodeURIComponent('z2m:0x0017880100000001')}`);
  assert.equal((await one.json()).name, 'living_room_lamp');
  assert.equal((await api(ctx.base, ctx.tokens.guest, '/api/devices/nope')).status, 404);
});

test('POST /api/devices/:id/set', async () => {
  const path = '/api/devices/z2m:0x0017880100000001/set';
  const ok = await api(ctx.base, ctx.tokens.member, path, { method: 'POST', body: { state: 'TOGGLE' } });
  assert.equal(ok.status, 202);
  assert.equal(client.published.at(-1).topic, 'zigbee2mqtt/living_room_lamp/set');
  const bad = await api(ctx.base, ctx.tokens.member, path, { method: 'POST', body: { brightness: -1 } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, />= 0/);
  const junk = await api(ctx.base, ctx.tokens.member, path, { method: 'POST', body: '{' });
  assert.equal(junk.status, 400);
});

test('unknown routes and wrong methods', async () => {
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/nope')).status, 404);
  const res = await api(ctx.base, ctx.tokens.admin, '/api/devices', { method: 'DELETE' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});
