import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { OBJECT_CATALOG } from '../../../packages/shared/src/objects.js';
import { makeObject } from '../src/views/scene-objects.js';
import { moveRoomGeometry, removeRoomCorner, splitRoomWall } from '../src/room-edits.js';

const first = { id: 'first', floor: 0, points: [[0, 0], [4, 0], [4, 4], [0, 4]] };
const next = { id: 'next', floor: 0, points: [[4, 0], [8, 0], [8, 4], [4, 4]] };
const plan = { rooms: [first, next], devices: [{ roomId: 'first', position: [1, 2, 1] }] };

test('moving a shared wall updates both rooms and moving a whole room carries its devices', () => {
  const moved = moveRoomGeometry(plan, first.id, 'wall', 1, [1, 0]);
  assert.deepEqual(moved.rooms[0].points[1], [5, 0]);
  assert.deepEqual(moved.rooms[1].points[0], [5, 0]);
  const translated = moveRoomGeometry(plan, first.id, 'room', 0, [0.5, 1]);
  assert.deepEqual(translated.devices[0].position, [1.5, 2, 2]);
  assert.equal(translated.rooms[1], next);
  assert.throws(() => moveRoomGeometry(plan, first.id, 'corner', 1, [-4, 0]), /cross a wall/);
});

test('splitting a shared wall preserves a door along both directions', () => {
  const opening = { edge: 1, type: 'door', offset: 2.8, width: .8, bottom: 0, height: 2 };
  const equipped = { ...plan, rooms: [{ ...first, openings: [opening] }, next] };
  const updated = splitRoomWall(equipped, first.id, 1);
  const [a, b] = updated.rooms;
  assert.deepEqual(a.points[2], [4, 2]);
  assert.deepEqual(b.points[4], [4, 2]);
  assert.equal(a.openings[0].edge, 2);
  assert.ok(Math.abs(a.openings[0].offset - .8) < 1e-6);
  assert.throws(() => removeRoomCorner(updated, a.id, 2), /Move the openings/);
  const empty = splitRoomWall(plan, first.id, 1);
  assert.deepEqual(removeRoomCorner(empty, first.id, 2).rooms.map((r) => r.points), [first.points, next.points]);
});

test('the 64 catalog entries build real meshes with their configured sizes', () => {
  assert.equal(new Set(OBJECT_CATALOG.map((entry) => entry.id)).size, 64);
  for (const entry of OBJECT_CATALOG) {
    const mesh = makeObject({ type: entry.id, color: entry.color, size: entry.size, position: [0, 0, 0], rotation: 0 });
    const actual = new Box3().setFromObject(mesh).getSize(new Vector3()).toArray();
    actual.forEach((value, i) => assert.ok(Math.abs(value - entry.size[i]) < 0.0001, entry.name));
  }
});
