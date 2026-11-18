import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createZigbee2mqttProvider } from '../src/providers/zigbee2mqtt/index.js';
import { FakeMqttClient, bridgeDevices } from './helpers.js';

function setup() {
  const client = new FakeMqttClient();
  const registry = new DeviceRegistry();
  createZigbee2mqttProvider({ client, registry });
  client.receive('zigbee2mqtt/bridge/devices', bridgeDevices);
  return { client, registry };
}

test('subscribes to bridge, state and availability topics', () => {
  const { client } = setup();
  assert.deepEqual(client.subscriptions, [
    'zigbee2mqtt/bridge/devices', 'zigbee2mqtt/bridge/state',
    ...['living_room_lamp', 'bathroom_sensor', 'double_switch'].flatMap((name) => [
      `zigbee2mqtt/${name}`, `zigbee2mqtt/${name}/availability`,
    ]),
  ]);
});

test('discovers devices and skips the coordinator', () => {
  const { registry } = setup();
  const ids = registry.list().map((d) => d.id);
  assert.deepEqual(ids, ['z2m:0x0017880100000001', 'z2m:0x00158d0000000002', 'z2m:0x00158d0000000003']);
  const lamp = registry.get('z2m:0x0017880100000001');
  assert.equal(lamp.name, 'living_room_lamp');
  assert.equal(lamp.vendor, 'Philips');
  assert.equal(lamp.capabilities.length, 6);
});

test('tracks state and availability by friendly name', () => {
  const { client, registry } = setup();
  client.receive('zigbee2mqtt/bathroom_sensor', { temperature: 21.5, humidity: 48 });
  client.receive('zigbee2mqtt/bathroom_sensor', { battery: 90 });
  client.receive('zigbee2mqtt/bathroom_sensor/availability', { state: 'offline' });
  const sensor = registry.get('z2m:0x00158d0000000002');
  assert.deepEqual(sensor.state, { temperature: 21.5, humidity: 48, battery: 90 });
  assert.equal(sensor.available, false);
  client.receive('zigbee2mqtt/bathroom_sensor/availability', 'online');
  assert.equal(sensor.available, true);
});

test('ignores unknown devices, set topics and junk payloads', () => {
  const { client, registry } = setup();
  client.receive('zigbee2mqtt/unknown', { a: 1 });
  client.receive('zigbee2mqtt/living_room_lamp/set', { state: 'ON' });
  client.receive('zigbee2mqtt/living_room_lamp', 'not json');
  assert.deepEqual(registry.get('z2m:0x0017880100000001').state, {});
});

test('rediscovery keeps state, follows renames and prunes removed devices', () => {
  const { client, registry } = setup();
  client.receive('zigbee2mqtt/living_room_lamp', { state: 'ON' });
  const list = JSON.parse(bridgeDevices).filter((d) => d.friendly_name !== 'double_switch');
  list[1].friendly_name = 'sofa_lamp';
  client.receive('zigbee2mqtt/bridge/devices', list);
  const lamp = registry.get('z2m:0x0017880100000001');
  assert.equal(lamp.name, 'sofa_lamp');
  assert.deepEqual(lamp.state, { state: 'ON' });
  assert.equal(registry.get('z2m:0x00158d0000000003'), undefined);
  client.receive('zigbee2mqtt/sofa_lamp', { brightness: 10 });
  assert.equal(lamp.state.brightness, 10);
});

test('commands are validated and published to the set topic', async () => {
  const { client, registry } = setup();
  await registry.command('z2m:0x0017880100000001', { state: 'ON', brightness: 200 });
  assert.deepEqual(client.published, [{ topic: 'zigbee2mqtt/living_room_lamp/set', payload: '{"state":"ON","brightness":200}' }]);
  await assert.rejects(registry.command('z2m:0x0017880100000001', { brightness: 999 }), { status: 400 });
  await assert.rejects(registry.command('z2m:0x0017880100000001', { bogus: 1 }), /Unknown capability/);
  await assert.rejects(registry.command('z2m:0x00158d0000000002', { temperature: 20 }), /read-only/);
  await assert.rejects(registry.command('z2m:nope', { state: 'ON' }), { status: 404 });
  assert.equal(client.published.length, 1);
});

test('discovers the base topic and follows retained state for names with slashes', async () => {
  const client = new FakeMqttClient();
  const registry = new DeviceRegistry();
  const provider = createZigbee2mqttProvider({ client, registry, baseTopic: '', discoveryWindow: 1 });
  try {
    assert.deepEqual(client.subscriptions, ['+/bridge/devices']);
    const added = once(registry, 'device:added');
    client.receive('mqtt/bridge/devices', [null, { friendly_name: 'Unrelated' }]);
    const list = JSON.parse(bridgeDevices);
    list[1].friendly_name = 'living-room/lamp';
    client.receive('house/bridge/devices', list);
    const [lamp] = await added;
    assert.equal(lamp.name, 'living-room/lamp');
    assert.ok(client.subscriptions.includes('house/living-room/lamp'));
    assert.ok(client.subscriptions.includes('house/living-room/lamp/availability'));
    assert.ok(!client.subscriptions.includes('+/bridge/devices'));
    const state = once(registry, 'state');
    client.receive('house/living-room/lamp', { brightness: 100 }, { retain: true });
    assert.deepEqual((await state).slice(1), [{ brightness: 100 }, { retained: true }]);
    await registry.command(lamp.id, { brightness: 150 });
    assert.equal(client.published.at(-1).topic, 'house/living-room/lamp/set');

    client.receive('house/bridge/state', { state: 'offline' });
    await assert.rejects(registry.command(lamp.id, { brightness: 125 }), { status: 503 });
    client.receive('house/living-room/lamp/availability', 'offline');
    client.receive('house/bridge/state', { state: 'online' });
    assert.equal(registry.get(lamp.id).available, false);
    client.end();
    assert.equal(registry.list().every((device) => device.available === false), true);
  } finally {
    provider.close();
  }
});

test('auto discovery reports multiple bridges and leaves control disabled until one is selected', async () => {
  const client = new FakeMqttClient();
  const registry = new DeviceRegistry();
  const status = new Promise((resolve) => {
    createZigbee2mqttProvider({ client, registry, baseTopic: '', discoveryWindow: 1, report: (s) => {
      if (s.phase === 'multiple-bridges') resolve(s);
    } });
  });
  client.receive('house/bridge/devices', bridgeDevices);
  client.receive('garage/bridge/devices', []);
  assert.deepEqual((await status).candidates, ['garage', 'house']);
  assert.equal(registry.list().length, 0);
});
