import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlKind, splitCapabilities, labelFor, formatValue, deviceIcon } from '../src/controls.js';

const cap = (over) => ({ property: 'x', name: 'x', type: 'numeric', readable: true, writable: false, min: null, max: null, ...over });

test('controlKind picks a control per capability type', () => {
  assert.equal(controlKind(cap({ type: 'binary', writable: true })), 'toggle');
  assert.equal(controlKind(cap({ type: 'binary' })), 'value');
  assert.equal(controlKind(cap({ writable: true, min: 0, max: 254 })), 'slider');
  assert.equal(controlKind(cap({ writable: true })), 'value');
  assert.equal(controlKind(cap({ type: 'enum', writable: true, values: ['OPEN', 'CLOSE', 'STOP'] })), 'buttons');
  assert.equal(controlKind(cap({ type: 'enum', writable: true, values: ['a', 'b', 'c', 'd', 'e'] })), 'select');
  assert.equal(controlKind(cap({ type: 'composite' })), 'json');
  assert.equal(controlKind(cap({ readable: false, writable: false })), 'hidden');
});

test('splitCapabilities separates diagnostics and drops hidden ones', () => {
  const { primary, diagnostic } = splitCapabilities([
    cap({ property: 'temperature' }),
    cap({ property: 'battery', category: 'diagnostic' }),
    cap({ property: 'ghost', readable: false }),
  ]);
  assert.deepEqual(primary.map((c) => c.property), ['temperature']);
  assert.deepEqual(diagnostic.map((c) => c.property), ['battery']);
});

test('labelFor prefers explicit labels and humanizes properties', () => {
  assert.equal(labelFor(cap({ property: 'color_temp', name: 'color_temp' })), 'Color temp');
  assert.equal(labelFor(cap({ property: 'color_temp', name: 'Color temperature' })), 'Color temperature');
  assert.equal(labelFor(cap({ property: 'state_left', name: 'state' })), 'State left');
});

test('formatValue handles units, binary values and missing values', () => {
  assert.equal(formatValue(cap({ unit: '°C' }), 21.456), '21.5 °C');
  assert.equal(formatValue(cap({ type: 'binary', valueOn: 'ON', valueOff: 'OFF' }), 'ON'), 'On');
  assert.equal(formatValue(cap({}), undefined), '–');
  assert.equal(formatValue(cap({ type: 'composite' }), { x: 1 }), '{"x":1}');
});

test('deviceIcon infers the device kind', () => {
  assert.equal(deviceIcon({ capabilities: [cap({ group: 'light' })] }), 'light');
  assert.equal(deviceIcon({ capabilities: [cap({ group: 'switch_left' })] }), 'switch');
  assert.equal(deviceIcon({ capabilities: [cap({ property: 'temperature', group: null })] }), 'sensor');
  assert.equal(deviceIcon({ capabilities: [] }), 'device');
});

test('parseBundle accepts raw JSON and fenced Markdown answers', async () => {
  globalThis.location ??= { origin: 'http://localhost' };
  const { parseBundle } = await import('../src/views/ai.js');
  assert.deepEqual(parseBundle('{"pages":[]}'), { pages: [] });
  assert.deepEqual(parseBundle('Here you go:\n```json\n{"actions":[]}\n```\nEnjoy'), { actions: [] });
  assert.throws(() => parseBundle('no json here'), /not valid JSON/);
});

test('readEvents parses a streamed SSE body split across chunks', async () => {
  const { readEvents } = await import('../src/views/chat.js');
  const chunks = ['event: start\ndata: {"conversationId":"c1"}\n\nevent: te', 'xt\ndata: {"delta":"Hi"}\n\n'];
  const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
  const events = [];
  for await (const e of readEvents({ body })) events.push(e);
  assert.deepEqual(events, [{ event: 'start', data: { conversationId: 'c1' } }, { event: 'text', data: { delta: 'Hi' } }]);
});
