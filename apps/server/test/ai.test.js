import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { ActionStore, ActionEngine } from '../src/config/actions.js';
import { importConfig } from '../src/ai/importer.js';
import { buildContext } from '../src/ai/context.js';
import { startApi, api } from './helpers.js';

let ctx, env;

before(async () => {
  const registry = new DeviceRegistry();
  const demo = createDemoProvider({ registry, tickMs: 60_000 });
  const store = new JsonStore(null);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const engine = new ActionEngine({ actions, registry, sleep: async () => {} });
  env = { registry, demo, pages, actions, engine };
  ctx = await startApi(registry, { pages, actions, engine });
});
after(() => {
  env.demo.stop();
  ctx.close();
});

async function mcpClient(token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const text = (result) => result.content.map((c) => c.text).join('\n');

// ---- importer --------------------------------------------------------------------------

test('import validates everything first and writes nothing on error', () => {
  const { pages, actions, registry } = env;
  assert.throws(() => importConfig({
    bundle: {
      actions: [{ name: 'Too bright', steps: [{ type: 'set', deviceId: 'demo:living_room_lamp', values: { brightness: 999 } }] }],
      pages: [
        { title: 'Ghosts', sections: [{ items: [{ type: 'device', deviceId: 'demo:nope' }] }] },
        { title: 'Wrong prop', sections: [{ items: [{ type: 'device', deviceId: 'demo:bathroom_sensor', properties: ['pressure'] }] }] },
        { title: 'Dangling', sections: [{ items: [{ type: 'action', actionId: 'missing' }] }] },
      ],
    },
    pages, actions, registry,
  }), (err) => {
    assert.match(err.message, /brightness must be <= 254/);
    assert.match(err.message, /unknown device demo:nope/);
    assert.match(err.message, /has no capability pressure/);
    assert.match(err.message, /unknown action missing/);
    return true;
  });
  assert.equal(pages.list().length, 0);
  assert.equal(actions.list().length, 0);
});

test('import creates, then updates by id; pages can reference actions in the same bundle', () => {
  const { pages, actions, registry } = env;
  const bundle = {
    actions: [{ name: 'Evening', steps: [{ type: 'set', deviceId: 'demo:living_room_lamp', values: { state: 'ON', brightness: 120 } }] }],
    pages: [{ title: 'Lounge', icon: '🛋️', sections: [{ items: [{ type: 'action', actionId: 'evening' }] }] }],
  };
  assert.deepEqual(importConfig({ bundle, pages, actions, registry }), {
    created: { pages: ['lounge'], actions: ['evening'] },
    updated: { pages: [], actions: [] },
  });
  const again = importConfig({ bundle, pages, actions, registry });
  assert.deepEqual(again.updated, { pages: ['lounge'], actions: ['evening'] });
  assert.equal(pages.list().length, 1);
  pages.delete('lounge');
  actions.delete('evening');
});

test('context document lists devices, existing config and the formats', () => {
  const doc = buildContext(env);
  assert.match(doc, /# HomeyVibe home configuration context/);
  assert.match(doc, /"id": "demo:living_room_lamp"/);
  assert.match(doc, /"access": "read\+write"/);
  assert.match(doc, /## Action format/);
});

// ---- HTTP: context download, import, access tokens ---------------------------------------

test('GET /api/ai/context downloads Markdown; POST /api/ai/import needs config:write', async () => {
  const res = await api(ctx.base, ctx.tokens.guest, '/api/ai/context');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/markdown/);
  assert.match(res.headers.get('content-disposition'), /homeyvibe-context\.md/);
  assert.match(await res.text(), /Devices \(5\)/);

  const bundle = { pages: [{ title: 'Imported', sections: [] }] };
  assert.equal((await api(ctx.base, ctx.tokens.member, '/api/ai/import', { method: 'POST', body: bundle })).status, 403);
  const ok = await api(ctx.base, ctx.tokens.admin, '/api/ai/import', { method: 'POST', body: bundle });
  assert.deepEqual((await ok.json()).created.pages, ['imported']);
  env.pages.delete('imported');
});

test('access tokens: create, use, list without secret, revoke', async () => {
  const created = await api(ctx.base, ctx.tokens.member, '/api/auth/tokens', { method: 'POST', body: { name: 'Claude Desktop' } });
  assert.equal(created.status, 201);
  const { id, token } = await created.json();
  assert.match(token, /^hv_/);
  assert.equal((await (await api(ctx.base, token, '/api/auth/me')).json()).username, 'member');
  const list = await (await api(ctx.base, ctx.tokens.member, '/api/auth/tokens')).json();
  assert.deepEqual(list.map((t) => t.name), ['Claude Desktop']);
  assert.equal(list[0].token, undefined);
  assert.equal((await api(ctx.base, ctx.tokens.guest, `/api/auth/tokens/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api(ctx.base, ctx.tokens.member, `/api/auth/tokens/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(ctx.base, token, '/api/auth/me')).status, 401);
  assert.equal((await api(ctx.base, ctx.tokens.member, '/api/auth/tokens', { method: 'POST', body: {} })).status, 400);
});

// ---- MCP --------------------------------------------------------------------------------

test('MCP: refuses requests without a token', async () => {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
});

test('MCP: admin sees tools, reads the home, configures it, and controls devices', async () => {
  const client = await mcpClient(ctx.tokens.admin);
  try {
    assert.match(client.getInstructions(), /Start with get_home_overview/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'apply_configuration', 'control_device', 'delete_action', 'delete_page', 'get_home_overview',
      'list_devices', 'run_action', 'save_action', 'save_page',
    ]);
    const saveAction = tools.find((t) => t.name === 'save_action');
    assert.ok(saveAction.inputSchema.properties.action, 'save_action has a typed action schema');

    const overview = JSON.parse(text(await client.callTool({ name: 'get_home_overview', arguments: {} })));
    assert.equal(overview.devices.length, 5);
    assert.equal(overview.you.role, 'admin');

    const found = JSON.parse(text(await client.callTool({ name: 'list_devices', arguments: { query: 'blind' } })));
    assert.deepEqual(found.map((d) => d.id), ['demo:bedroom_blind']);

    const applied = await client.callTool({
      name: 'apply_configuration',
      arguments: {
        actions: [{ name: 'Night', steps: [{ type: 'set', deviceId: 'demo:living_room_lamp', values: { state: 'OFF' } }] }],
        pages: [{ title: 'Bedroom', icon: '🛏️', sections: [
          { title: 'Scenes', items: [{ type: 'action', actionId: 'night' }] },
          { items: [{ type: 'device', deviceId: 'demo:bedroom_blind', properties: ['position'] }] },
        ] }],
      },
    });
    assert.equal(applied.isError, undefined, text(applied));
    assert.ok(env.pages.get('bedroom'));

    const bad = await client.callTool({
      name: 'save_page',
      arguments: { page: { title: 'Bad', sections: [{ items: [{ type: 'device', deviceId: 'demo:nope' }] }] } },
    });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /unknown device demo:nope/);

    await client.callTool({ name: 'control_device', arguments: { deviceId: 'demo:living_room_lamp', values: { state: 'ON' } } });
    assert.equal(env.registry.get('demo:living_room_lamp').state.state, 'ON');
    const ran = await client.callTool({ name: 'run_action', arguments: { actionId: 'night' } });
    assert.equal(text(ran), 'Ran night.');
    assert.equal(env.registry.get('demo:living_room_lamp').state.state, 'OFF');

    const deleted = await client.callTool({ name: 'delete_action', arguments: { actionId: 'night' } });
    assert.match(text(deleted), /still referenced on pages: bedroom/);
    await client.callTool({ name: 'delete_page', arguments: { pageId: 'bedroom' } });
    assert.equal(env.pages.get('bedroom'), null);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ['set_up_my_home']);
  } finally {
    await client.close();
  }
});

test('MCP: tools respect the role of the token owner', async () => {
  const client = await mcpClient(ctx.tokens.guest);
  try {
    const read = await client.callTool({ name: 'list_devices', arguments: {} });
    assert.equal(read.isError, undefined);
    const control = await client.callTool({ name: 'control_device', arguments: { deviceId: 'demo:living_room_lamp', values: { state: 'ON' } } });
    assert.equal(control.isError, true);
    assert.match(text(control), /not allowed/);
    const config = await client.callTool({ name: 'save_page', arguments: { page: { title: 'X', sections: [] } } });
    assert.equal(config.isError, true);
  } finally {
    await client.close();
  }
});
