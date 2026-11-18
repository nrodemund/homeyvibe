import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoPlace, bounds, centroid, deviceSummary, floorsOf, lightLevel, pointInPolygon, polygonArea, roomAt, wallSegments,
} from '../src/floorplan.js';

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
