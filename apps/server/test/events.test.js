import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { createApiHandler } from '../src/http/api.js';

let server, base, registry, demo;

before(async () => {
  registry = new DeviceRegistry();
  demo = createDemoProvider({ registry, tickMs: 60_000 });
  server = createServer(createApiHandler({ registry }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  demo.stop();
  server.closeAllConnections();
  server.close();
});

/** Read SSE events from a fetch response until `count` events arrived. */
async function readEvents(res, count) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) events.push({ event, data: JSON.parse(data) });
      if (events.length >= count) return events;
    }
  }
  return events;
}

test('demo provider loads simulated devices with state', () => {
  const lamp = registry.get('demo:living_room_lamp');
  assert.equal(lamp.name, 'Living room lamp');
  assert.equal(lamp.state.brightness, 180);
  assert.equal(registry.list().length, 4);
});

test('demo commands update state, including toggle', async () => {
  await registry.command('demo:living_room_lamp', { state: 'TOGGLE', brightness: 50 });
  assert.equal(registry.get('demo:living_room_lamp').state.state, 'OFF');
  assert.equal(registry.get('demo:living_room_lamp').state.brightness, 50);
  await assert.rejects(registry.command('demo:living_room_lamp', { brightness: 9999 }), { status: 400 });
});

test('GET /api/events streams a snapshot, then live state changes', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const pending = readEvents(res, 2);
  setTimeout(() => registry.command('demo:hallway_switch', { state_left: 'ON' }), 50);
  const [snapshot, state] = await pending;
  controller.abort();
  assert.equal(snapshot.event, 'snapshot');
  assert.equal(snapshot.data.length, 4);
  assert.deepEqual(state, { event: 'state', data: { id: 'demo:hallway_switch', changes: { state_left: 'ON' } } });
});

test('event listeners are removed when the client disconnects', async () => {
  await new Promise((r) => setTimeout(r, 100)); // let earlier streams finish closing
  const before = registry.listenerCount('state');
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  await readEvents(res, 1);
  assert.equal(registry.listenerCount('state'), before + 1);
  controller.abort();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(registry.listenerCount('state'), before);
});
