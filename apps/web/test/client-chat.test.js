import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createClientChat } from '../src/ai/client-chat.js';

const kit = {
  model: 'claude-opus-5-5',
  system: [{ type: 'text', text: 'You are the assistant', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'control_device', title: 'Control a device', description: 'd', input_schema: { type: 'object' } }],
};

/** Fake Anthropic client replaying scripted messages and recording requests. */
function fake(script) {
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
              for (const b of step.content) if (b.type === 'text') listeners.forEach((l) => l(b.text));
              return step;
            },
          };
        },
      },
    },
  };
}
const msg = (stop_reason, content) => ({ role: 'assistant', stop_reason, content });

test('client chat calls Claude from the device and runs tools on the server', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 's' };
  const client = fake([
    msg('tool_use', [thinking, { type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'control_device', input: { deviceId: 'lamp', values: { state: 'ON' } } }]),
    msg('end_turn', [{ type: 'text', text: ' Done.' }]),
    msg('end_turn', [{ type: 'text', text: 'Again.' }]),
  ]);
  const ran = [];
  const chat = createClientChat({
    loadKit: async () => kit,
    runTool: async (name, input) => {
      ran.push([name, input]);
      return { ok: true, text: 'Sent.' };
    },
    createClient: async (key) => {
      assert.equal(key, 'sk-ant-device');
      return client;
    },
  });
  const events = [];
  const { conversationId } = await chat.send({ apiKey: 'sk-ant-device', message: 'Lamp on', emit: (e, d) => events.push([e, d]) });
  assert.deepEqual(events.map((e) => e[0]), ['start', 'text', 'tool', 'tool_result', 'text', 'done']);
  assert.equal(events[2][1].title, 'Control a device');
  assert.deepEqual(ran, [['control_device', { deviceId: 'lamp', values: { state: 'ON' } }]]);

  const [first, second] = client.requests;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.output_config, { effort: 'medium' });
  assert.equal(first.fallbacks, 'default');
  assert.equal(first.tools[0].eager_input_streaming, true);
  assert.equal(first.tools[0].title, undefined);
  assert.deepEqual(first.system, kit.system);
  assert.deepEqual(second.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 't1', content: 'Sent.' }]);

  await chat.send({ apiKey: 'sk-ant-device', conversationId, message: 'More', emit: () => {} });
  const history = client.requests[2].messages;
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(history[1].content[0], thinking);
});

test('client chat: failed tools, refusals, cut-off tool input and a rejected key', async () => {
  const run = async (script, runTool = async () => ({ ok: false, text: 'not allowed' })) => {
    const events = [];
    const chat = createClientChat({ loadKit: async () => kit, runTool, createClient: async () => fake(script) });
    try {
      await chat.send({ apiKey: 'sk-ant-x', message: 'hi', emit: (e, d) => events.push([e, d]) });
    } catch (err) {
      events.push(['thrown', err.message]);
    }
    return events;
  };
  const failed = await run([msg('tool_use', [{ type: 'tool_use', id: 'a', name: 'control_device', input: {} }]), msg('end_turn', [])]);
  assert.deepEqual(failed.find((e) => e[0] === 'tool_result')[1], { name: 'control_device', ok: false });

  const refused = await run([msg('refusal', [])]);
  assert.deepEqual(refused.find((e) => e[0] === 'error')[1], { message: 'Claude declined to help with that request.' });

  let ran = false;
  const cut = await run([msg('max_tokens', [{ type: 'tool_use', id: 'a', name: 'control_device', input: { deviceId: 'x' } }])], async () => {
    ran = true;
    return { ok: true, text: '' };
  });
  assert.equal(ran, false);
  assert.match(cut.at(-1)[1], /cut off/);

  const badKey = await run([new Anthropic.AuthenticationError(401, { type: 'error' }, 'bad', new Headers())]);
  assert.deepEqual(badKey.at(-1), ['thrown', 'The Claude API key on this device was rejected. Check it in the assistant.']);

  const noKey = createClientChat({ loadKit: async () => kit, createClient: async () => fake([]) });
  await assert.rejects(noKey.send({ apiKey: null, message: 'hi', emit: () => {} }), /Add a Claude API key/);
});
