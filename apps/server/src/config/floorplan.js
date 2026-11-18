import { EventEmitter } from 'node:events';
import { Validator, ID_RE, slugify } from './validate.js';
import { placementSettings, roomSettings } from './floorplan-settings.js';
import { OBJECT_TYPES } from '../../../../packages/shared/src/objects.js';

/**
 * The home's floor plan, shared by every 3D page. Coordinates are meters seen from above:
 * x to the right, z towards the viewer; y is height above the room's floor.
 *
 * {
 *   rooms: [{ id: 'living-room', name: 'Living room', floor: 0, height: 2.5,
 *             points: [[0, 0], [5, 0], [5, 4], [0, 4]] }],
 *   devices: [{ deviceId: 'z2m:0x…', roomId: 'living-room', position: [1.2, 2.1, 0.8] }],
 * }
 *
 * Rooms can come from drawing in the app, from a room scan, or from an AI.
 */
export const MAX_COORD = 500;

export class FloorplanStore extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
  }

  get() {
    return this.store.read('floorplan', { rooms: [], devices: [] });
  }

  replace(input) {
    const plan = normalizeFloorplan(input);
    this.store.write('floorplan', plan);
    this.emit('changed', plan);
    return plan;
  }
}

export function normalizeFloorplan(input) {
  const v = new Validator();
  if (!v.check(input && typeof input === 'object' && !Array.isArray(input), 'floorplan must be an object like { rooms, devices }')) {
    v.throwIfInvalid();
  }
  const rooms = input.rooms ?? [];
  const devices = input.devices ?? [];
  const objects = input.objects ?? [];
  const coord = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;

  const roomIds = new Set();
  const roomExtras = [];
  if (v.array(rooms, 'rooms', { max: 200 })) {
    rooms.forEach((room, i) => {
      const path = `rooms[${i}]`;
      if (!v.check(room && typeof room === 'object', `${path} must be an object`)) return;
      v.string(room.name, `${path}.name`, { max: 80 });
      const id = room.id ?? slugify(room.name);
      if (v.check(ID_RE.test(id), `${path}.id must be lowercase letters, numbers and dashes`)) {
        v.check(!roomIds.has(id), `${path}.id ${id} is used twice`);
        roomIds.add(id);
      }
      if (room.floor !== undefined) v.check(Number.isInteger(room.floor) && Math.abs(room.floor) <= 50, `${path}.floor must be a whole number`);
      if (room.height !== undefined) v.check(typeof room.height === 'number' && room.height >= 1 && room.height <= 20, `${path}.height must be between 1 and 20 meters`);
      if (v.check(Array.isArray(room.points) && room.points.length >= 3 && room.points.length <= 64,
        `${path}.points must list 3 to 64 corners as [x, z]`)) {
        const ok = room.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(coord));
        if (v.check(ok, `${path}.points must be [x, z] pairs in meters (at most ${MAX_COORD})`)) {
          v.check(Math.abs(polygonArea(room.points)) >= 0.25, `${path} is too small (under 0.25 m²)`);
        }
      }
      roomExtras[i] = roomSettings(room, path, v);
    });
  }

  const deviceIds = new Set();
  const deviceExtras = [];
  if (v.array(devices, 'devices', { max: 1000 })) {
    devices.forEach((d, i) => {
      const path = `devices[${i}]`;
      if (!v.check(d && typeof d === 'object', `${path} must be an object`)) return;
      if (v.string(d.deviceId, `${path}.deviceId`)) {
        v.check(!deviceIds.has(d.deviceId), `${path}: ${d.deviceId} is placed twice`);
        deviceIds.add(d.deviceId);
      }
      if (d.roomId !== undefined && d.roomId !== null) v.check(roomIds.has(d.roomId), `${path}.roomId ${d.roomId} is not a room in this plan`);
      v.check(Array.isArray(d.position) && d.position.length === 3 && d.position.every(coord) && d.position[1] >= 0,
        `${path}.position must be [x, y, z] in meters with y (height) at least 0`);
      deviceExtras[i] = placementSettings(d, path, v);
    });
  }
  const objectIds = new Set();
  if (v.array(objects, 'objects', { max: 500 })) {
    objects.forEach((object, i) => {
      const path = `objects[${i}]`;
      if (!v.check(object && typeof object === 'object' && !Array.isArray(object), `${path} must be an object`)) return;
      v.check(typeof object.id === 'string' && ID_RE.test(object.id) && !objectIds.has(object.id), `${path}.id must be unique`);
      objectIds.add(object.id);
      v.check(OBJECT_TYPES.has(object.type), `${path}.type must be a catalog object`);
      v.string(object.name, `${path}.name`, { optional: true, max: 80 });
      v.check(Number.isInteger(object.floor) && Math.abs(object.floor) <= 50, `${path}.floor must be a whole number`);
      v.check(object.roomId == null || roomIds.has(object.roomId), `${path}.roomId must refer to a room`);
      v.check(Array.isArray(object.position) && object.position.length === 3 && object.position.every(coord) &&
        object.position[1] >= 0, `${path}.position must be [x, height, z]`);
      v.check(Array.isArray(object.size) && object.size.length === 3 &&
        object.size.every((n) => Number.isFinite(n) && n >= .01 && n <= 30), `${path}.size must contain dimensions from 0.01 to 30 m`);
      v.check(Number.isFinite(object.rotation), `${path}.rotation must be a finite angle`);
      v.check(typeof object.color === 'string' && /^#[\da-f]{6}$/i.test(object.color), `${path}.color must be a hex color`);
    });
  }
  v.throwIfInvalid();

  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    rooms: rooms.map((r, i) => ({
      id: r.id ?? slugify(r.name),
      name: r.name.trim(),
      floor: r.floor ?? 0,
      height: r.height ?? 2.5,
      points: r.points.map(([x, z]) => [round(x), round(z)]),
      ...roomExtras[i],
    })),
    ...(input.objects !== undefined ? { objects: objects.map((o) => ({
      id: o.id, type: o.type, name: o.name?.trim() ?? OBJECT_TYPES.get(o.type).name, floor: o.floor, roomId: o.roomId ?? null,
      position: o.position.map(round), size: o.size.map(round), rotation: ((o.rotation % 360) + 360) % 360, color: o.color,
    })) } : {}),
    devices: devices.map((d, i) => ({
      deviceId: d.deviceId,
      roomId: d.roomId ?? null,
      position: d.position.map(round),
      ...deviceExtras[i],
    })),
  };
}

/** Signed area (shoelace). */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}
