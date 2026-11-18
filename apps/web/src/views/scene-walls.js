import * as THREE from 'three';
import { polygonArea } from '../floorplan.js';
import { roomWalls, wallPieces } from '../floorplan-visuals.js';

/** Draw room walls and their openings. */
export function addWalls(world, rooms, colors) {
  for (const wall of roomWalls(rooms)) {
    const [[x, z], [toX, toZ]] = [wall.from, wall.to];
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = -Math.atan2(toZ - z, toX - x);
    world.add(group);

    const finishes = wall.rooms.map(({ room, reversed }) => ({ room, left: (polygonArea(room.points) > 0) !== reversed }));
    const left = finishes.find((face) => face.left)?.room.style;
    const right = finishes.find((face) => !face.left)?.room.style;
    const style = left ?? right ?? {};
    const thickness = Math.max(0.02, ...wall.rooms.map(({ room }) => room.style?.wallThickness ?? 0.08));
    const openingTop = Math.max(0, ...wall.openings.map((o) => o.bottom + o.height + 0.12));
    const height = Math.max(...wall.rooms.map(({ room }) => room.style?.wallHeight ?? Math.min(room.height ?? 2.5, Math.max(1, openingTop))));
    const material = (finish) => {
      const opacity = Math.max(0, Math.min(1, finish?.wallOpacity ?? 0.4));
      return new THREE.MeshStandardMaterial({
        color: finish?.wallColor ?? colors.muted, roughness: 0.8, transparent: opacity < 1, opacity, depthWrite: opacity === 1,
      });
    };
    const base = material(style);
    const leftFace = left && left !== style ? material(left) : base;
    const rightFace = right && right !== style ? material(right) : base;
    const materials = [base, base, base, base, leftFace, rightFace];
    const pieces = wallPieces(wall.length, height, wall.openings);
    for (const { from, to, bottom, top } of pieces) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(to - from, top - bottom, thickness), materials);
      mesh.position.set((from + to) / 2, (bottom + top) / 2, 0);
      group.add(mesh);
    }
    if (!pieces.length) for (const item of new Set(materials)) item.dispose();

    const edgeStyle = finishes.find(({ room }) => room.style?.edges)?.room.style;
    if (edgeStyle) {
      const points = [[0, height], [wall.length, height], [wall.length, 0], [0, 0]];
      addOutline(group, points, edgeStyle.edgeColor ?? colors.line);
    }
    for (const opening of wall.openings) {
      const from = Math.max(0, opening.offset);
      const to = Math.min(wall.length, opening.offset + opening.width);
      const bottom = opening.bottom;
      const top = Math.min(height, bottom + opening.height);
      if (to - from < 0.001 || top - bottom < 0.001) continue;
      addOutline(group, [[from, bottom], [from, top], [to, top], [to, bottom]],
        edgeStyle?.edgeColor ?? (opening.type === 'window' ? '#75c6df' : '#ad8666'), opening.type === 'window');
      if (opening.type === 'window') {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(to - from, top - bottom, 0.016),
          new THREE.MeshStandardMaterial({ color: '#83cdec', transparent: true, opacity: 0.36, depthWrite: false }));
        pane.position.set((from + to) / 2, (bottom + top) / 2, 0);
        group.add(pane);
      }
    }
  }

}

function addOutline(group, points, color, closed = true) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const material = new THREE.LineBasicMaterial({ color });
  group.add(closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material));
}
