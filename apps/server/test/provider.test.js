import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(client.subscriptions, ['zigbee2mqtt/bridge/devices', 'zigbee2mqtt/+', 'zigbee2mqtt/+/availability']);
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
