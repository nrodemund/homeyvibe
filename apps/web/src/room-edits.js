import { polygonArea } from './floorplan.js';

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const deltaPoint = (point, delta) => point.map((value, i) => Math.round((value + delta[i]) * 1000) / 1000);

/** Move a room, a corner, or both endpoints of a wall from a drag's original state. */
export function moveRoomGeometry(plan, id, type, index, delta) {
  const room = plan.rooms.find((r) => r.id === id);
  const corner = room.points[index];
  const wall = [corner, room.points[(index + 1) % room.points.length]];
  const rooms = plan.rooms.map((current) => {
    if (current.floor !== room.floor || (type === 'room' && current.id !== id)) return current;
    const points = current.points.map((point) => (
      type === 'room' || (type === 'corner' && samePoint(point, corner)) ||
      (type === 'wall' && wall.some((end) => samePoint(point, end))) ? deltaPoint(point, delta) : point));
    if (!validRoom(points, current.openings ?? [])) throw new Error('That move would cross a wall or leave an opening outside its wall.');
    return { ...current, points };
  });
  if (type !== 'room') return { ...plan, rooms };
  const translate = (entry) => {
    if (entry.roomId !== id) return entry;
    const [x, height, z] = entry.position;
    const [nextX, nextZ] = deltaPoint([x, z], delta);
    if (Math.max(Math.abs(nextX), Math.abs(nextZ)) > 500) throw new Error('The move takes an object outside the plan.');
    return { ...entry, position: [nextX, height, nextZ] };
  };
  return { ...plan, rooms, devices: plan.devices.map(translate), objects: (plan.objects ?? []).map(translate) };
}

/** Split a wall and its exact neighbour at a common point, preserving openings. */
export function splitRoomWall(plan, id, edge) {
  const room = plan.rooms.find((r) => r.id === id);
  const a = room.points[edge];
  const b = room.points[(edge + 1) % room.points.length];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const matches = [];
  const blocked = [];
  for (const other of plan.rooms.filter((r) => r.floor === room.floor)) {
    for (const [index, start] of other.points.entries()) {
      const end = other.points[(index + 1) % other.points.length];
      const reverse = samePoint(start, b) && samePoint(end, a);
      if (!reverse && !(samePoint(start, a) && samePoint(end, b))) continue;
      if (other.points.length >= 64) throw new Error('This room already has 64 corners.');
      matches.push({ id: other.id, index, reverse });
      for (const item of (other.openings ?? []).filter((o) => o.edge === index)) {
        const left = reverse ? length - item.offset - item.width : item.offset;
        blocked.push([left, left + item.width]);
      }
    }
  }
  const candidates = [length / 2, ...blocked.flatMap(([l, r]) => [l - .05, r + .05])];
  const split = candidates.find((point) => point >= .15 && point <= length - .15 &&
    !blocked.some(([l, r]) => point > l - .02 && point < r + .02));
  if (split === undefined) throw new Error('There is no room to split this wall between its openings.');
  const point = a.map((n, i) => Math.round((n + (b[i] - n) * split / length) * 1000) / 1000);
  return {
    ...plan,
    rooms: plan.rooms.map((other) => {
      const match = matches.find((m) => m.id === other.id);
      if (!match) return other;
      const cut = match.reverse ? length - split : split;
      const points = [...other.points];
      points.splice(match.index + 1, 0, point);
      const openings = (other.openings ?? []).map((item) => {
        if (item.edge < match.index) return item;
        if (item.edge === match.index && item.offset < cut) return item;
        return { ...item, edge: item.edge + 1, offset: item.edge === match.index ? item.offset - cut : item.offset };
      });
      return { ...other, points, openings };
    }),
  };
}

/** Remove a selected corner unless doing so would remove an opening. */
export function removeRoomCorner(plan, id, index) {
  const room = plan.rooms.find((r) => r.id === id);
  const a = room.points[(index + room.points.length - 1) % room.points.length];
  const b = room.points[index];
  const c = room.points[(index + 1) % room.points.length];
  const rooms = plan.rooms.map((other) => {
    if (other.floor !== room.floor) return other;
    const size = other.points.length;
    const remove = other.id === id ? index : other.points.findIndex((point, i) => {
      if (!samePoint(point, b)) return false;
      const left = other.points[(i + size - 1) % size];
      const right = other.points[(i + 1) % size];
      return (samePoint(left, c) && samePoint(right, a)) || (samePoint(left, a) && samePoint(right, c));
    });
    if (remove < 0) return other;
    if (size <= 3) throw new Error('A room needs at least three corners.');
    const previous = (remove + size - 1) % size;
    if ((other.openings ?? []).some((o) => o.edge === remove || o.edge === previous)) {
      throw new Error('Move the openings on the two adjoining walls first.');
    }
    const points = other.points.filter((_, i) => i !== remove);
    const openings = (other.openings ?? []).map((o) => o.edge > remove ? { ...o, edge: o.edge - 1 } : o);
    if (!validRoom(points, openings)) throw new Error('That corner would leave an invalid room.');
    return { ...other, points, openings };
  });
  return { ...plan, rooms };
}

function validRoom(points, openings) {
  if (Math.abs(polygonArea(points)) < .25 || points.flat().some((n) => Math.abs(n) > 500)) return false;
  const orientation = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const between = (a, b, c) => c.every((value, i) => value >= Math.min(a[i], b[i]) && value <= Math.max(a[i], b[i]));
  for (const [i, a] of points.entries()) {
    const next = (i + 1) % points.length;
    const b = points[next];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < .05 || openings.some((o) => o.edge === i && o.offset + o.width > length + .001)) return false;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      const sideC = orientation(a, b, c), sideD = orientation(a, b, d);
      const sideA = orientation(c, d, a), sideB = orientation(c, d, b);
      if ((sideC * sideD < 0 && sideA * sideB < 0) ||
        (!sideC && between(a, b, c)) || (!sideD && between(a, b, d)) ||
        (!sideA && between(c, d, a)) || (!sideB && between(c, d, b))) return false;
    }
  }
  return true;
}
