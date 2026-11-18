import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoPlace, bounds, centroid, deviceSummary, floorsOf, lightLevel, pointInPolygon, polygonArea, roomAt, wallSegments,
} from '../src/floorplan.js';
import { arrangeMarkers, chartPoints, displayCapabilities, markerReading, mergeHistory, pageIdForHash, roomWalls, wallPieces } from '../src/floorplan-visuals.js';

const square = (x, z, size = 4) => [[x, z], [x + size, z], [x + size, z + size], [x, z + size]];
const lightCaps = [
  { property: 'state', name: 'state', type: 'binary', readable: true, writable: true, valueOn: 'ON', valueOff: 'OFF', group: 'light' },
  { property: 'brightness', name: 'brightness', type: 'numeric', readable: true, writable: true, min: 0, max: 254, group: 'light' },
];
const sensorCaps = [
  { property: 'temperature', name: 'temperature', type: 'numeric', readable: true, writable: false, unit: '°C', min: null, max: null },
  { property: 'humidity', name: 'humidity', type: 'numeric', readable: true, writable: false, unit: '%', min: null, max: null },
];
const lamp = { id: 'lamp', name: 'Kitchen lamp', capabilities: lightCaps, state: { state: 'ON', brightness: 127 } };
const sensor = { id: 'sensor', name: 'Climate sensor', capabilities: sensorCaps, state: { temperature: 21.46, humidity: 48 } };

const plan = {
  rooms: [
    { id: 'kitchen', name: 'Kitchen', floor: 0, points: square(0, 0) },
    { id: 'bedroom', name: 'Bedroom', floor: 1, points: square(0, 0, 3) },
    { id: 'guest-bedroom', name: 'Guest bedroom', floor: 1, points: square(3, 0, 3) },
  ],
  devices: [],
};

test('polygon helpers', () => {
  assert.equal(polygonArea(square(0, 0)), 16);
  assert.deepEqual(centroid(square(0, 0)), [2, 2]);
  assert.deepEqual(centroid([[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]).map((n) => Math.round(n * 100) / 100), [2.2, 2.2]);
  assert.equal(pointInPolygon([1, 1], square(0, 0)), true);
  assert.equal(pointInPolygon([5, 1], square(0, 0)), false);
  assert.equal(roomAt(plan, 1, 1, 1).id, 'bedroom');
  assert.equal(roomAt(plan, 1, 1, 0).id, 'kitchen');
  assert.deepEqual(bounds(plan.rooms), { minX: 0, maxX: 6, minZ: 0, maxZ: 4 });
  assert.deepEqual(floorsOf(plan), [0, 1]);
  assert.deepEqual(floorsOf({ rooms: [] }), [0]);
});

test('wallSegments lists shared walls once', () => {
  const walls = wallSegments([{ points: square(0, 0, 3) }, { points: square(3, 0, 3) }]);
  assert.equal(walls.length, 7);
});

test('autoPlace keeps placed devices and guesses rooms from names and section titles', () => {
  const withPlaced = { ...plan, devices: [{ deviceId: 'sensor', roomId: null, position: [9, 1, 9] }] };
  const other = { id: 'x', name: 'Mystery plug', capabilities: [], state: {} };
  const guest = { id: 'g', name: 'Lamp', capabilities: lightCaps, state: {} };
  const result = autoPlace(withPlaced, [lamp, sensor, other, guest], new Map([['g', 'Guest bedroom lights']]));
  assert.deepEqual(result.get('sensor'), { position: [9, 1, 9], roomId: null, placed: true });
  assert.deepEqual(result.get('lamp'), { position: [2, 2.1, 2], roomId: 'kitchen', placed: false });
  assert.equal(result.get('g').roomId, 'guest-bedroom'); // the longer room name wins over "Bedroom"
  const leftover = result.get('x');
  assert.equal(leftover.roomId, null);
  assert.ok(leftover.position[2] > 4, 'leftovers line up outside the plan');
});

test('deviceSummary and lightLevel describe state for 3D labels', () => {
  assert.equal(deviceSummary(lamp), 'On · 50%');
  assert.equal(deviceSummary(sensor), '21.5 °C · 48 %');
  assert.equal(deviceSummary({ ...lamp, state: { state: 'OFF', brightness: 10 } }), 'Off');
  assert.equal(deviceSummary({ ...sensor, available: false }), 'Offline · 21.5 °C');
  assert.equal(lightLevel(lamp), 127 / 254);
  assert.equal(lightLevel({ ...lamp, state: { state: 'OFF' } }), 0);
  assert.equal(lightLevel(sensor), null);
});

test('limits helpers: ranges, entries and summaries', async () => {
  const { entryFor, limitableCaps, parseRange, summarize } = await import('../src/limits.js');
  const setpoint = { property: 'occupied_heating_setpoint', type: 'numeric', writable: true, min: 5, max: 35, label: 'Target temperature' };
  assert.deepEqual(parseRange(setpoint, '18', '22'), [18, 22]);
  assert.deepEqual(parseRange(setpoint, '', '22'), [5, 22]);
  assert.equal(parseRange(setpoint, '', ''), null);
  assert.throws(() => parseRange(setpoint, '23', '22'), /above the highest/);
  assert.throws(() => parseRange(setpoint, '2', '22'), /stay within 5–35/);
  assert.deepEqual(limitableCaps({ capabilities: [setpoint, { ...setpoint, property: 'x', writable: false }, { ...setpoint, property: 'b', category: 'diagnostic' }] }).map((c) => c.property), ['occupied_heating_setpoint']);
  const limits = { default: 'view', devices: { r: { access: 'control', ranges: { t: [18, 22] } }, s: { access: 'hidden' } } };
  assert.deepEqual(entryFor(limits, 'r'), { access: 'control', ranges: { t: [18, 22] } });
  assert.deepEqual(entryFor(limits, 'new'), { access: 'view', ranges: {} });
  assert.equal(summarize(limits), 'new devices view only · 1 hidden · 1 value range');
  assert.equal(summarize({ default: 'control', devices: {} }), 'No limits');
});

test('sensor styles read the right capability, scale values, and distinguish no reading', () => {
  assert.deepEqual(displayCapabilities(sensor, 'status'), []);
  assert.deepEqual(displayCapabilities(sensor, 'chart').map((cap) => cap.property), ['temperature', 'humidity']);
  const adjusted = markerReading(sensor, { mode: 'threshold', property: 'temperature', min: 18, max: 24, threshold: 20 });
  assert.equal(adjusted.text, '21.5 °C');
  assert.equal(adjusted.active, true);
  assert.ok(Math.abs(adjusted.fraction - 0.5766667) < 0.00001);
  assert.equal(markerReading({ ...sensor, state: {} }, { mode: 'threshold' }).active, null);
  assert.equal(markerReading(lamp, { mode: 'status', property: 'state' }).active, true);
  assert.equal(lightLevel({ ...lamp, available: false }), 0);
});

test('the history plot uses real time and merges a snapshot with newer live measurements', () => {
  const now = 100_000_000;
  const points = mergeHistory([
    [[0, 15], [now - 43_200_000, 20], [now - 1200, 24]],
    [[now - 1000, 25], [now, 30]],
  ], now);
  assert.deepEqual(points, [[now - 43_200_000, 20], [now, 30]]);
  assert.deepEqual(chartPoints(points, { min: 20, max: 30 }, now, 100, 40), [[50, 40], [100, 0]]);
});

test('shared wall openings work from either direction and cut only the opening area', () => {
  const rooms = [
    { points: square(0, 0, 3) },
    { points: square(3, 0, 3), openings: [{ edge: 3, offset: 0.5, width: 1, bottom: 0.8, height: 1 }] },
  ];
  const wall = roomWalls(rooms).find((candidate) => candidate.rooms.length === 2);
  assert.equal(wall.openings[0].offset, 1.5);
  const pieces = wallPieces(wall.length, 2.5, wall.openings);
  const area = pieces.reduce((sum, p) => sum + (p.to - p.from) * (p.top - p.bottom), 0);
  assert.equal(area, 3 * 2.5 - 1);
  assert.deepEqual(pieces.filter((p) => p.from === 1.5 && p.to === 2.5).map((p) => [p.bottom, p.top]), [[0, 0.8], [1.8, 2.5]]);
});

test('root opens the chosen page while explicit navigation and All devices still work', () => {
  const pages = [{ id: 'home', startPage: true }, { id: 'kitchen' }];
  assert.equal(pageIdForHash('', pages), 'home');
  assert.equal(pageIdForHash('#/', pages), null);
  assert.equal(pageIdForHash('#/page/kitchen', pages), 'kitchen');
  assert.equal(pageIdForHash('', pages.slice(1)), null);
});

test('adjacent device labels have distinct hit areas', () => {
  const first = { x: 100, y: 70, w: 70, h: 30 };
  const second = { ...first, x: 105 };
  const [[, firstCenter], [, secondCenter]] = arrangeMarkers([first, second], 300, 180);
  const firstTop = first.y - firstCenter * first.h;
  const secondTop = second.y - secondCenter * second.h;
  assert.ok(secondTop + second.h < firstTop);
});
