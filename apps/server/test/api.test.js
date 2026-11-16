import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createZigbee2mqttProvider } from '../src/providers/zigbee2mqtt/index.js';
import { createApiHandler } from '../src/http/api.js';
import { FakeMqttClient, bridgeDevices } from './helpers.js';

let server, base, client;

before(async () => {
  client = new FakeMqttClient();
  const registry = new DeviceRegistry();
  createZigbee2mqttProvider({ client, registry });
  client.receive('zigbee2mqtt/bridge/devices', bridgeDevices);
  server = createServer(createApiHandler({ registry }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /api/health', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.deepEqual(await res.json(), { ok: true, name: 'homeyvibe', devices: 3 });
});

test('GET /api/devices and /api/devices/:id', async () => {
  const list = await (await fetch(`${base}/api/devices`)).json();
  assert.equal(list.length, 3);
  const one = await fetch(`${base}/api/devices/${encodeURIComponent('z2m:0x0017880100000001')}`);
  assert.equal((await one.json()).name, 'living_room_lamp');
  assert.equal((await fetch(`${base}/api/devices/nope`)).status, 404);
});

test('POST /api/devices/:id/set', async () => {
  const url = `${base}/api/devices/z2m:0x0017880100000001/set`;
  const ok = await fetch(url, { method: 'POST', body: JSON.stringify({ state: 'TOGGLE' }) });
  assert.equal(ok.status, 202);
  assert.equal(client.published.at(-1).topic, 'zigbee2mqtt/living_room_lamp/set');
  const bad = await fetch(url, { method: 'POST', body: JSON.stringify({ brightness: -1 }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, />= 0/);
  const junk = await fetch(url, { method: 'POST', body: '{' });
  assert.equal(junk.status, 400);
});
