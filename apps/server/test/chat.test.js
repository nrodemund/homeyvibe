import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { PageStore } from '../src/config/pages.js';
import { ActionStore, ActionEngine } from '../src/config/actions.js';
import { AiSettings, ChatService, DEFAULT_MODEL } from '../src/ai/chat.js';
import { DEFAULT_OPENAI_MODEL } from '../src/ai/openai.js';
import { startApi, api } from './helpers.js';

/**
 * Stand-in for the Anthropic client: replays scripted replies and records every request.
 * A script entry is a message object, or a function (params) => message, or an Error to throw.
 */
function fakeClient(script) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const step = script.shift();
          const listeners = [];
          return {
            on(event, cb) {
              if (event === 'text') listeners.push(cb);
              return this;
            },
            async finalMessage() {
              if (step instanceof Error) throw step;
              const message = typeof step === 'function' ? step(params) : step;
              for (const block of message.content) if (block.type === 'text') for (const l of listeners) l(block.text);
              return message;
            },
          };
        },
      },
    },
  };
}

const msg = (stop_reason, content) => ({ id: 'msg', type: 'message', role: 'assistant', model: DEFAULT_MODEL, stop_reason, content });
const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };

let ctx, env, script, client;

before(async () => {
  const registry = new DeviceRegistry();
  const demo = createDemoProvider({ registry, tickMs: 60_000 });
  const store = new JsonStore(null);
  const pages = new PageStore({ store });
  const actions = new ActionStore({ store });
  const engine = new ActionEngine({ actions, registry, sleep: async () => {} });
  const aiSettings = new AiSettings({ store, env: {} });
  const chat = new ChatService({
    settings: aiSettings, registry, pages, actions, engine,
    createClient: (apiKey) => {
      assert.equal(apiKey, 'sk-ant-test-1234');
      return (client = fakeClient(script));
    },
  });
  env = { registry, demo, pages, actions, aiSettings };
  ctx = await startApi(registry, { pages, actions, engine, aiSettings, chat });
});
after(() => {
  env.demo.stop();
  ctx.close();
});

/** POST /api/ai/chat and collect SSE events. */
async function sendChat(token, body) {
  const res = await api(ctx.base, token, '/api/ai/chat', { method: 'POST', body });
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, json: await res.json() };
  const events = [];
  for (const block of (await res.text()).split('\n\n')) {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    if (event) events.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) });
  }
  return { status: res.status, events };
}

// ---- settings ----------------------------------------------------------------------------

test('settings: not configured at first; only admins set the key; the key is never returned', async () => {
  assert.equal((await (await api(ctx.base, ctx.tokens.guest, '/api/ai/settings')).json()).configured, false);
  const noKey = await sendChat(ctx.tokens.member, { message: 'hi' });
  assert.equal(noKey.status, 409);
  assert.match(noKey.json.error, /not set up yet/);

  assert.equal((await api(ctx.base, ctx.tokens.member, '/api/ai/settings', { method: 'PATCH', body: { apiKey: 'sk-ant-test-1234' } })).status, 403);
  const bad = await api(ctx.base, ctx.tokens.admin, '/api/ai/settings', { method: 'PATCH', body: { apiKey: 'nope' } });
  assert.equal(bad.status, 400);
  const ok = await api(ctx.base, ctx.tokens.admin, '/api/ai/settings', { method: 'PATCH', body: { apiKey: 'sk-ant-test-1234' } });
  const status = await ok.json();
  assert.deepEqual(status, { provider: 'claude', configured: true, source: 'settings', keyHint: '…1234', model: DEFAULT_MODEL });
  assert.ok(!JSON.stringify(status).includes('sk-ant-test-1234'));
});

test('settings: environment key is used when none is saved', () => {
  const s = new AiSettings({ store: new JsonStore(null), env: { ANTHROPIC_API_KEY: 'sk-ant-env' } });
  assert.equal(s.apiKey(), 'sk-ant-env');
  assert.equal(s.status().source, 'environment');
});

// ---- chat loop -----------------------------------------------------------------------------

test('chat: runs tools, streams text, and sends the right request', async () => {
  script = [
    msg('tool_use', [thinking, { type: 'text', text: 'Turning it on.' }, { type: 'tool_use', id: 'tu1', name: 'control_device', input: { deviceId: 'demo:living_room_lamp', values: { state: 'ON', brightness: 200 } } }]),
    (params) => {
      const last = params.messages.at(-1);
      assert.equal(last.role, 'user');
      assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Sent {"state":"ON","brightness":200} to Living room lamp.' }]);
      return msg('end_turn', [{ type: 'text', text: ' Done, the lamp is on.' }]);
    },
  ];
  env.registry.updateState('demo:living_room_lamp', { state: 'OFF' });
  const { events } = await sendChat(ctx.tokens.member, { message: 'Turn on the living room lamp' });

  assert.deepEqual(events.map((e) => e.event), ['start', 'text', 'tool', 'tool_result', 'text', 'done']);
  assert.equal(events.find((e) => e.event === 'tool').data.title, 'Control a device');
  assert.equal(events.filter((e) => e.event === 'text').map((e) => e.data.delta).join(''), 'Turning it on. Done, the lamp is on.');
  assert.equal(env.registry.get('demo:living_room_lamp').state.brightness, 200);

  const [first] = client.requests;
  assert.equal(first.model, DEFAULT_MODEL);
  assert.deepEqual(first.output_config, { effort: 'medium' });
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(first.thinking, undefined);
  assert.deepEqual(first.system[0].cache_control, { type: 'ephemeral' });
  assert.match(first.system[1].text, /role: member/);
  const control = first.tools.find((t) => t.name === 'control_device');
  assert.equal(control.eager_input_streaming, true);
  assert.equal(control.input_schema.type, 'object');
  assert.equal(control.input_schema.$schema, undefined);
  assert.deepEqual(control.input_schema.required.sort(), ['deviceId', 'values']);
});

test('chat: conversations continue with the full history, thinking blocks unchanged', async () => {
  script = [msg('end_turn', [thinking, { type: 'text', text: 'Hello!' }]), msg('end_turn', [{ type: 'text', text: 'Again!' }])];
  const first = await sendChat(ctx.tokens.member, { message: 'Hi' });
  const conversationId = first.events.find((e) => e.event === 'done').data.conversationId;
  await sendChat(ctx.tokens.member, { message: 'And again', conversationId });
  const history = client.requests[0].messages; // a client is created per turn
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(history[1].content[0], thinking);

  // Another user cannot continue someone else's conversation: they get a fresh one.
  script = [msg('end_turn', [{ type: 'text', text: 'New chat' }])];
  await sendChat(ctx.tokens.admin, { message: 'peek', conversationId });
  assert.equal(client.requests[0].messages.length, 1);
});

test('chat: tools follow the user role, and bad tool input is reported back to Claude', async () => {
  script = [
    msg('tool_use', [
      { type: 'tool_use', id: 'a', name: 'control_device', input: { deviceId: 'demo:living_room_lamp', values: { state: 'OFF' } } },
      { type: 'tool_use', id: 'b', name: 'save_page', input: { page: { sections: [] } } },
    ]),
    (params) => {
      const [denied, invalid] = params.messages.at(-1).content;
      assert.equal(denied.is_error, true);
      assert.match(denied.content, /not allowed/);
      assert.equal(invalid.is_error, true);
      assert.match(invalid.content, /Invalid input/);
      return msg('end_turn', [{ type: 'text', text: 'You can only look at devices.' }]);
    },
  ];
  const { events } = await sendChat(ctx.tokens.guest, { message: 'Turn off the lamp and make a page' });
  assert.deepEqual(events.filter((e) => e.event === 'tool_result').map((e) => e.data.ok), [false, false]);
  assert.equal(env.registry.get('demo:living_room_lamp').state.state, 'ON');
});

test('chat: API errors and refusals become friendly error events', async () => {
  script = [new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers())];
  const auth = await sendChat(ctx.tokens.member, { message: 'hi' });
  assert.deepEqual(auth.events.at(-1), { event: 'error', data: { message: 'The Claude API key was rejected. Check it in Set up with AI.' } });

  script = [msg('refusal', [])];
  const refused = await sendChat(ctx.tokens.member, { message: 'something odd' });
  assert.equal(refused.events.find((e) => e.event === 'error').data.message, 'Claude declined to help with that request.');
});

test('chat: input limits', async () => {
  assert.equal((await sendChat(ctx.tokens.member, { message: '   ' })).status, 400);
  assert.equal((await sendChat(ctx.tokens.member, { message: 'x'.repeat(5000) })).status, 400);
  assert.equal((await sendChat(null, { message: 'hi' })).status, 401);
});

test('OpenAI shared assistant uses the same schema, access checks and tool feedback', async () => {
  const store = new JsonStore(null);
  const settings = new AiSettings({ store, env: { OPENAI_API_KEY: 'sk-proj-example-key' } });
  assert.equal(settings.status().provider, 'openai');
  assert.equal(settings.status().model, DEFAULT_OPENAI_MODEL);
  assert.ok(!JSON.stringify(settings.status()).includes('sk-proj-example-key'));
  const requests = [];
  const role = { id: 'guest', role: 'guest', username: 'guest', displayName: 'Guest' };
  const service = new ChatService({
    settings, registry: env.registry, pages: env.pages, actions: env.actions,
    openAiFetch: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer sk-proj-example-key');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      requests.push(body);
      if (requests.length > 1) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'View only.' } }] });
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
        id: 'call-1', type: 'function', function: { name: 'control_device', arguments: '{"deviceId":"demo:living_room_lamp","values":{"state":"ON"}}' },
      }] } }] });
    },
  });
  const events = [];
  await service.send({ user: role, message: 'Turn it on', emit: (event, data) => events.push([event, data]) });
  assert.equal(requests[0].model, DEFAULT_OPENAI_MODEL);
  assert.equal(requests[0].messages[0].role, 'developer');
  assert.ok(requests[0].tools.find((t) => t.function.name === 'control_device').function.parameters.properties.values);
  assert.match(requests[1].messages.at(-1).content, /not allowed/);
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'call-1');
  assert.deepEqual(events.map(([event]) => event), ['start', 'tool', 'tool_result', 'text', 'done']);
  assert.equal(events[2][1].ok, false);
});

test('shared assistant keeps existing Claude settings when switching providers', () => {
  const store = new JsonStore(null);
  store.write('ai-settings', { apiKey: 'sk-ant-existing', model: 'claude-existing' });
  const settings = new AiSettings({ store, env: {} });
  assert.equal(settings.provider(), 'claude');
  const openai = settings.update({ provider: 'openai', apiKey: 'sk-proj-new', model: 'gpt-5-mini' });
  assert.equal(openai.provider, 'openai');
  assert.equal(settings.model('claude'), 'claude-existing');
  assert.equal(settings.apiKey(), 'sk-proj-new');
  settings.update({ provider: 'claude' });
  assert.equal(settings.apiKey(), 'sk-ant-existing');
  assert.equal(settings.model(), 'claude-existing');
});
