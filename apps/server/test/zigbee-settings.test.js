import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { ActionEngine, ActionStore } from '../src/config/actions.js';
import { AccessStore } from '../src/auth/access.js';
import { ZigbeeConnection } from '../src/providers/zigbee2mqtt/connection.js';
import { FakeMqttClient, bridgeDevices, startApi, api } from './helpers.js';

function setup(env = {}) {
  const store = new JsonStore(null);
  const registry = new DeviceRegistry();
  const connections = [];
  const connect = (broker, options) => {
    const client = new FakeMqttClient();
    connections.push({ broker, options, client });
    return client;
  };
  const zigbee = new ZigbeeConnection({ registry, store, env, connect, probeMs: 5 });
  return { store, registry, connections, zigbee, connect };
}

test('auto mode continues past an MQTT broker with no Zigbee2MQTT catalog', async (t) => {
  const { zigbee, connections } = setup({ Z2M_BASE_TOPIC: 'home/zigbee' });
  t.after(() => zigbee.close());
  zigbee.start();
  assert.equal(connections[0].broker, 'mqtt://mosquitto:1883');
  assert.equal(zigbee.status().phase, 'waiting');
  const deadline = Date.now() + 1000;
  while (connections.length === 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(connections[1].broker, 'mqtt://host.docker.internal:1883');
  connections[1].client.receive('home/zigbee/bridge/devices', []);
  assert.equal(zigbee.status().phase, 'ready');
  assert.match(zigbee.status().message, /no paired devices/);
});

test('admins can save broker settings and retry, with password and network details protected', async (t) => {
  const env = { MQTT_URL: 'mqtt://reader:secret-mqtt@broker:1883', Z2M_BASE_TOPIC: 'zigbee2mqtt' };
  const { zigbee, connections, registry, store, connect } = setup(env);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const access = new AccessStore({ store });
  const ctx = await startApi(registry, { zigbee, pages, actions, access });
  t.after(() => { zigbee.close(); ctx.close(); });
  zigbee.start();
  const path = '/api/integrations/zigbee2mqtt';
  const input = { mode: 'manual', url: 'mqtts://pi.local:8883', username: 'home', password: 'replacement-secret', baseTopic: 'home/zb/' };
  const request = (token, method, body, suffix = '') => api(ctx.base, token, path + suffix, { method, body });
  for (const role of ['member', 'guest']) {
    assert.equal((await request(ctx.tokens[role], 'GET')).status, 403);
    assert.equal((await request(ctx.tokens[role], 'PUT', input)).status, 403);
    assert.equal((await request(ctx.tokens[role], 'DELETE')).status, 403);
    assert.equal((await request(ctx.tokens[role], 'POST', undefined, '/retry')).status, 403);
  }
  const admin = ctx.tokens.admin;
  const initial = await (await request(admin, 'GET')).json();
  assert.equal(initial.settings.url, 'mqtt://broker:1883');
  assert.ok(!JSON.stringify(initial).includes('secret-mqtt'));
  const invalid = await request(admin, 'PUT', { ...input, url: 'http://bad', baseTopic: '+' });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Broker URL|broker URL/);
  assert.equal(connections.length, 1);
  const saved = await (await request(admin, 'PUT', input)).json();
  assert.equal(saved.source, 'settings');
  assert.equal(saved.settings.baseTopic, 'home/zb');
  assert.equal(saved.settings.hasPassword, true);
  assert.ok(!JSON.stringify(saved).includes(input.password));
  const active = connections.at(-1);
  assert.equal(active.options.password, input.password);
  assert.equal(connections[0].client.connected, false);
  active.client.receive('home/zb/bridge/devices', bridgeDevices);
  assert.equal(registry.list().length, 3);

  const mcp = new Client({ name: 'codex-style-client', version: '1' });
  const { token } = await ctx.auth.createAccessToken(ctx.auth.authenticate(admin).id, 'Codex');
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', ctx.base), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  t.after(() => mcp.close());
  const diagnosis = await mcp.callTool({ name: 'diagnose_zigbee2mqtt', arguments: {} });
  assert.deepEqual(JSON.parse(diagnosis.content[0].text), { phase: 'ready', message: 'A Zigbee2MQTT catalog was received.' });
  access.setAi({ canConfigure: false });
  assert.equal((await mcp.callTool({ name: 'diagnose_zigbee2mqtt', arguments: {} })).isError, true);

  const restored = new ZigbeeConnection({ registry, store, env, connect });
  t.after(() => restored.close());
  assert.equal(restored.status().settings.hasPassword, true);
  assert.equal(restored.status().settings.url, input.url);
  assert.equal((await request(admin, 'POST', undefined, '/retry')).status, 200);
  assert.equal(connections.at(-1).options.password, input.password);
  await request(admin, 'PUT', { ...input, url: 'mqtts://new-broker:8883', password: undefined });
  assert.equal(connections.at(-1).options.password, undefined);
  assert.equal((await (await request(admin, 'DELETE')).json()).source, 'environment');
  assert.equal(connections.at(-1).options.password, 'secret-mqtt');
});

test('state trigger ignores retained MQTT reports while keeping the displayed state', async (t) => {
  const { zigbee, connections, registry, store } = setup({ MQTT_URL: 'mqtt://broker', Z2M_BASE_TOPIC: 'zigbee2mqtt' });
  const actions = new ActionStore({ store });
  const engine = new ActionEngine({ actions, registry });
  engine.start();
  zigbee.start();
  t.after(() => { engine.stop(); zigbee.close(); });
  const client = connections[0].client;
  client.receive('zigbee2mqtt/bridge/devices', bridgeDevices);
  actions.create({
    name: 'Sensor gets warm',
    triggers: [{ type: 'state', deviceId: 'z2m:0x00158d0000000002', property: 'temperature', op: 'gt', value: 25 }],
    steps: [{ type: 'set', deviceId: 'z2m:0x0017880100000001', values: { state: 'ON' } }],
  });
  client.receive('zigbee2mqtt/bathroom_sensor', { temperature: 26 }, { retain: true });
  assert.equal(registry.get('z2m:0x00158d0000000002').state.temperature, 26);
  assert.equal(client.published.length, 0);
  client.receive('zigbee2mqtt/bathroom_sensor', { temperature: 27 });
  assert.deepEqual(client.published, [{ topic: 'zigbee2mqtt/living_room_lamp/set', payload: '{"state":"ON"}' }]);
});
