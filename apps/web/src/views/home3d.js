// 3D page: the home's floor plan with live devices. Loaded on demand so three.js stays out of the main bundle.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { deviceIcon } from '../controls.js';
import { h, toast } from '../ui.js';
import {
  ICONS, autoPlace, bounds, centroid, defaultHeight, deviceSummary, floorsOf, lightLevel, roomAt, snap, wallSegments,
} from '../floorplan.js';

const WALL_HEIGHT = 1.0; // cut-away walls so you can look into the rooms
const WALL_THICKNESS = 0.08;
const CLICK_SLOP_PX = 6;

/**
 * @param {object} opts
 * @param {object} opts.plan floor plan { rooms, devices }
 * @param {Map<string, object>} opts.devices all known devices by id (kept live by the dashboard)
 * @param {string[]|null} opts.deviceIds devices this page shows; null = every placed device
 * @param {Map<string,string>} [opts.hints] deviceId -> text that may name its room (section titles)
 * @param {boolean} opts.canEdit may change the floor plan
 * @param {(device: object) => HTMLElement} opts.renderCard the dashboard's device card
 * @param {(plan: object) => Promise<object>} opts.onSave saves the plan, resolves with the stored plan
 */
export function createHome3d({ plan, devices, deviceIds, hints = new Map(), canEdit, renderCard, onSave }) {
  const canvasWrap = h('div.stage-canvas');
  const toolbar = h('div.stage-toolbar');
  const hint = h('p.stage-hint', { hidden: true });
  const panel = h('div.stage-panel', { hidden: true });
  const el = h('section.stage', { 'aria-label': '3D view of your home' }, canvasWrap, toolbar, hint, panel);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    el.replaceChildren(h('p.empty', {}, 'The 3D view needs WebGL, which this browser does not offer. Switch the page layout to grid to see these devices.'));
    return { el, update() {}, setPlan() {}, setDevices() {}, destroy() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  canvasWrap.append(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'stage-labels';
  canvasWrap.append(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 2;
  controls.maxDistance = 80;
  controls.addEventListener('change', requestRender);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-6, 12, 8);
  scene.add(sun);
  const world = new THREE.Group();
  scene.add(world);

  let saved = plan;
  let draft = null; // working copy while editing
  let floor = floorsOf(plan)[0];
  let selected = null; // { type: 'device'|'room', id }
  let mode = 'move'; // or 'draw' while editing
  let fitted = false;
  let colors = null;
  const deviceObjects = new Map(); // deviceId -> { group, mesh, label, light, stem }
  const roomMeshes = [];
  let preview = null;

  const current = () => draft ?? saved;
  const editing = () => draft !== null;

  // ---- what to show --------------------------------------------------------------------

  function shownDevices() {
    const ids = deviceIds ?? current().devices.map((d) => d.deviceId);
    return ids.map((id) => devices.get(id)).filter(Boolean);
  }

  function placements() {
    return autoPlace(current(), shownDevices(), hints);
  }

  function floorOf(roomId) {
    return current().rooms.find((r) => r.id === roomId)?.floor ?? floor;
  }

  // ---- scene building -------------------------------------------------------------------

  function readColors() {
    const css = getComputedStyle(el);
    const color = (name, fallback) => new THREE.Color(css.getPropertyValue(name).trim() || fallback);
    return {
      floor: color('--card', '#ffffff').lerp(color('--text', '#1b1d22'), 0.05), line: color('--line', '#e3e5ea'), muted: color('--muted', '#6b7180'),
      accent: color('--accent', '#4f6bed'), bg: color('--bg', '#f4f5f7'),
    };
  }

  function clearWorld() {
    world.traverse((obj) => {
      obj.geometry?.dispose();
      [].concat(obj.material ?? []).forEach((m) => m.dispose());
      if (obj.isCSS2DObject) obj.element.remove();
    });
    world.clear();
    deviceObjects.clear();
    roomMeshes.length = 0;
  }

  function build() {
    colors ??= readColors();
    clearWorld();
    const rooms = current().rooms.filter((r) => r.floor === floor);

    for (const room of rooms) {
      const shape = new THREE.Shape(room.points.map(([x, z]) => new THREE.Vector2(x, -z)));
      const isSelected = selected?.type === 'room' && selected.id === room.id;
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: isSelected ? colors.floor.clone().lerp(colors.accent, 0.25) : colors.floor, roughness: 0.9 }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.userData.roomId = room.id;
      world.add(mesh);
      roomMeshes.push(mesh);
      const [cx, cz] = centroid(room.points);
      const label = new CSS2DObject(h('span.room-label', {}, room.name));
      label.position.set(cx, 0.02, cz);
      world.add(label);
    }

    const wallMaterial = new THREE.MeshStandardMaterial({ color: colors.muted, transparent: true, opacity: 0.4, roughness: 0.8 });
    for (const [[x1, z1], [x2, z2]] of wallSegments(rooms)) {
      const length = Math.hypot(x2 - x1, z2 - z1);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(length + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS), wallMaterial);
      wall.position.set((x1 + x2) / 2, WALL_HEIGHT / 2, (z1 + z2) / 2);
      wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      world.add(wall);
    }

    if (editing()) {
      const b = bounds(rooms);
      const size = Math.ceil(Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 6) + 8);
      const grid = new THREE.GridHelper(size, size * 2, colors.line, colors.line);
      grid.position.set(snap((b.minX + b.maxX) / 2, 1), -0.002, snap((b.minZ + b.maxZ) / 2, 1));
      world.add(grid);
    }

    for (const [id, place] of placements()) {
      if (floorOf(place.roomId) !== floor) continue;
      const device = devices.get(id);
      if (device) addDevice(device, place);
    }
    renderToolbar();
    renderPanel();
    if (!fitted) fit();
    requestRender();
  }

  function addDevice(device, place) {
    const kind = deviceIcon(device);
    const [x, y, z] = place.position;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.userData.deviceId = device.id;

    const geometry = kind === 'light' ? new THREE.SphereGeometry(0.14, 24, 16)
      : kind === 'cover' ? new THREE.BoxGeometry(0.5, 0.4, 0.04)
        : new THREE.BoxGeometry(0.18, 0.18, 0.18);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.4 }));
    mesh.position.y = y;
    mesh.userData.deviceId = device.id;
    group.add(mesh);

    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, y, 0)]),
      new THREE.LineBasicMaterial({ color: colors.muted, transparent: true, opacity: 0.5 }),
    );
    group.add(stem);

    let light = null;
    if (kind === 'light') {
      light = new THREE.PointLight(0xffc977, 0, 5, 1.2);
      light.position.y = y;
      group.add(light);
    }

    const labelEl = h('button.device-label', { type: 'button', dataset: { deviceId: device.id } });
    labelEl.addEventListener('pointerdown', (e) => onPointerDown(e, device.id));
    const label = new CSS2DObject(labelEl);
    label.position.y = y + 0.28;
    group.add(label);

    world.add(group);
    const entry = { group, mesh, label, light, stem, kind };
    deviceObjects.set(device.id, entry);
    refreshDevice(device);
  }

  function refreshDevice(device) {
    const entry = deviceObjects.get(device.id);
    if (!entry) return;
    const level = lightLevel(device);
    const material = entry.mesh.material;
    if (level !== null) {
      material.color.set(level > 0 ? 0xffd27a : colors.muted);
      material.emissive.set(level > 0 ? 0xffb347 : 0x000000);
      material.emissiveIntensity = level * 1.5;
      entry.light.intensity = level * 4;
    } else {
      material.color.copy(device.available === false ? colors.muted : colors.accent);
    }
    const isSelected = selected?.type === 'device' && selected.id === device.id;
    const labelEl = entry.label.element;
    labelEl.classList.toggle('selected', isSelected);
    labelEl.classList.toggle('offline', device.available === false);
    labelEl.classList.toggle('on', level !== null && level > 0);
    const summary = deviceSummary(device);
    labelEl.replaceChildren(
      h('span.device-label-icon', { 'aria-hidden': 'true' }, ICONS[entry.kind]),
      h('span.device-label-text', {}, h('strong', {}, device.name), summary ? h('span', {}, summary) : null),
    );
    labelEl.setAttribute('aria-label', `${device.name}${summary ? `, ${summary}` : ''}`);
    requestRender();
  }

  function fit() {
    const rooms = current().rooms.filter((r) => r.floor === floor);
    const b = bounds(rooms);
    for (const { group } of deviceObjects.values()) {
      b.minX = Math.min(b.minX, group.position.x);
      b.maxX = Math.max(b.maxX, group.position.x);
      b.minZ = Math.min(b.minZ, group.position.z);
      b.maxZ = Math.max(b.maxZ, group.position.z);
    }
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    // Distance at which the plan (plus room for labels) fits both the horizontal and vertical field of view.
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const width = Math.max(b.maxX - b.minX, 3) + 2;
    const depth = Math.max(b.maxZ - b.minZ, 3) + 1;
    const distance = Math.max(width / (2 * Math.tan(hHalf)), depth / (2 * Math.tan(vHalf))) * 1.1;
    controls.target.set(cx, 0, cz);
    camera.position.set(cx, distance * 0.78, cz + distance * 0.63);
    controls.update();
    fitted = true;
    requestRender();
  }

  // ---- rendering --------------------------------------------------------------------------

  let frame = 0;
  function requestRender() {
    if (frame || !renderer) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const moving = controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
      if (moving) requestRender();
    });
  }

  const resizer = new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: hgt } = canvasWrap;
    if (!w || !hgt) return;
    renderer.setSize(w, hgt, false);
    labels.setSize(w, hgt);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    if (!colors) build();
    else requestRender();
  });
  resizer.observe(canvasWrap);

  // ---- pointer: select, drag devices, draw rooms -------------------------------------------

  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let gesture = null;

  function ndc(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  function groundPoint(e) {
    raycaster.setFromCamera(ndc(e), camera);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(ground, p) ? p : null;
  }

  function pickDevice(e) {
    raycaster.setFromCamera(ndc(e), camera);
    const hit = raycaster.intersectObjects([...deviceObjects.values()].map((d) => d.mesh))[0];
    return hit?.object.userData.deviceId ?? null;
  }

  function pickRoom(e) {
    raycaster.setFromCamera(ndc(e), camera);
    return raycaster.intersectObjects(roomMeshes)[0]?.object.userData.roomId ?? null;
  }

  function onPointerDown(e, labelDeviceId = null) {
    if (e.button !== 0) return;
    const deviceId = labelDeviceId ?? pickDevice(e);
    gesture = { x: e.clientX, y: e.clientY, deviceId, moved: false, kind: 'click' };
    if (editing() && deviceId) gesture.kind = 'drag';
    else if (editing() && mode === 'draw') {
      const p = groundPoint(e);
      if (p) gesture = { ...gesture, kind: 'draw', start: [snap(p.x, 0.25), snap(p.z, 0.25)] };
    }
    if (gesture.kind !== 'click') {
      controls.enabled = false;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!gesture) return;
    if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > CLICK_SLOP_PX) gesture.moved = true;
    if (!gesture.moved) return;
    const p = groundPoint(e);
    if (!p) return;
    if (gesture.kind === 'drag') {
      const entry = deviceObjects.get(gesture.deviceId);
      const placement = draft.devices.find((d) => d.deviceId === gesture.deviceId);
      if (!entry || !placement) return;
      placement.position = [snap(p.x, 0.05), placement.position[1], snap(p.z, 0.05)];
      entry.group.position.set(placement.position[0], 0, placement.position[2]);
      requestRender();
    } else if (gesture.kind === 'draw') {
      gesture.end = [snap(p.x, 0.25), snap(p.z, 0.25)];
      drawPreview(gesture.start, gesture.end);
    }
  }

  function onPointerUp(e) {
    window.removeEventListener('pointermove', onPointerMove);
    controls.enabled = true;
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.kind === 'drag' && g.moved) {
      const placement = draft.devices.find((d) => d.deviceId === g.deviceId);
      placement.roomId = roomAt(draft, placement.position[0], placement.position[2], floor)?.id ?? null;
      select({ type: 'device', id: g.deviceId });
      return;
    }
    if (g.kind === 'draw') {
      clearPreview();
      if (g.end) addRoom(g.start, g.end);
      return;
    }
    if (g.moved) return; // the camera was dragged
    if (g.deviceId) select({ type: 'device', id: g.deviceId });
    else if (editing()) {
      const roomId = pickRoom(e);
      select(roomId ? { type: 'room', id: roomId } : null);
    } else select(null);
  }

  canvasWrap.addEventListener('pointerdown', (e) => {
    if (e.target === renderer.domElement) onPointerDown(e);
  }, { capture: true });

  function drawPreview([x1, z1], [x2, z2]) {
    clearPreview();
    const w = Math.abs(x2 - x1);
    const d = Math.abs(z2 - z1);
    if (!w || !d) return;
    preview = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    preview.rotation.x = -Math.PI / 2;
    preview.position.set((x1 + x2) / 2, 0.01, (z1 + z2) / 2);
    scene.add(preview);
    requestRender();
  }

  function clearPreview() {
    if (!preview) return;
    scene.remove(preview);
    preview.geometry.dispose();
    preview.material.dispose();
    preview = null;
    requestRender();
  }

  function addRoom([x1, z1], [x2, z2]) {
    if (Math.abs(x2 - x1) < 0.5 || Math.abs(z2 - z1) < 0.5) {
      toast('Drag a bigger rectangle to draw a room.');
      return;
    }
    const [minX, maxX] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [minZ, maxZ] = [Math.min(z1, z2), Math.max(z1, z2)];
    const taken = new Set(draft.rooms.map((r) => r.id));
    let n = draft.rooms.length + 1;
    while (taken.has(`room-${n}`)) n++;
    draft.rooms.push({ id: `room-${n}`, name: `Room ${n}`, floor, height: 2.5, points: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] });
    for (const d of draft.devices) {
      if (!d.roomId) d.roomId = roomAt(draft, d.position[0], d.position[2], floor)?.id ?? null;
    }
    mode = 'move';
    select({ type: 'room', id: `room-${n}` });
    panel.querySelector('input')?.select();
  }

  function select(next) {
    selected = next;
    build();
  }

  // ---- toolbar and panel ----------------------------------------------------------------

  function renderToolbar() {
    const floors = [...new Set([...floorsOf(current()), floor])].sort((a, b) => a - b);
    const floorSelect = floors.length > 1 || editing()
      ? h('select', {
        'aria-label': 'Floor',
        onchange: (e) => {
          floor = Number(e.target.value);
          fitted = false;
          select(null);
        },
      }, floors.map((f) => h('option', { value: f, selected: f === floor }, floorName(f))),
      editing() ? h('option', { value: Math.max(...floors) + 1 }, '+ New floor') : null)
      : null;

    if (!editing()) {
      toolbar.replaceChildren(...[
        floorSelect,
        h('button.icon-button', { type: 'button', onclick: fit }, 'Fit'),
        canEdit ? h('button', { type: 'button', onclick: startEditing }, 'Edit layout') : null,
      ].filter(Boolean));
      hint.hidden = !(canEdit && current().rooms.length === 0);
      hint.textContent = 'No floor plan yet. Choose Edit layout to draw your rooms, or ask the assistant to set one up.';
      return;
    }
    toolbar.replaceChildren(
      h('button', {
        type: 'button',
        'aria-pressed': String(mode === 'draw'),
        onclick: () => {
          mode = mode === 'draw' ? 'move' : 'draw';
          select(null);
        },
      }, 'Draw room'),
      floorSelect,
      h('button.primary', { type: 'button', onclick: save }, 'Save'),
      h('button.icon-button', { type: 'button', onclick: cancelEditing }, 'Cancel'),
    );
    hint.hidden = false;
    hint.textContent = mode === 'draw'
      ? 'Drag on the floor to draw a rectangular room.'
      : 'Drag devices to move them. Tap a room to rename it.';
  }

  function renderPanel() {
    const content = panelContent();
    panel.hidden = !content;
    if (content) panel.replaceChildren(...content.filter(Boolean));
  }

  function panelContent() {
    const close = h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => select(null) }, '✕');
    const unplaced = editing() ? shownDevicesNotIn(draft) : [];
    const tray = unplaced.length
      ? h('div.stage-tray', {}, h('span.muted', {}, 'Not placed yet:'),
        unplaced.map((d) => h('button.chip', { type: 'button', onclick: () => placeDevice(d) }, `${ICONS[deviceIcon(d)]} ${d.name}`)))
      : null;

    if (selected?.type === 'device') {
      const device = devices.get(selected.id);
      if (!device) return null;
      if (!editing()) return [h('div.stage-panel-head', {}, close), renderCard(device)];
      const placement = draft.devices.find((d) => d.deviceId === device.id);
      const room = draft.rooms.find((r) => r.id === placement?.roomId);
      const height = h('output', {}, `${placement.position[1].toFixed(1)} m`);
      return [
        h('div.stage-panel-head', {}, h('strong', {}, device.name), close),
        h('p.muted', {}, room ? `In ${room.name}` : 'Not in a room'),
        h('label.field', {}, 'Height above the floor', h('div.slider', {},
          h('input', {
            type: 'range', min: 0, max: 4, step: 0.1, value: placement.position[1],
            oninput: (e) => {
              placement.position[1] = Number(e.target.value);
              height.textContent = `${placement.position[1].toFixed(1)} m`;
              const entry = deviceObjects.get(device.id);
              if (entry) {
                entry.mesh.position.y = placement.position[1];
                entry.label.position.y = placement.position[1] + 0.28;
                if (entry.light) entry.light.position.y = placement.position[1];
                entry.stem.geometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, placement.position[1], 0)]);
                requestRender();
              }
            },
          }),
          height)),
        h('button.icon-button', {
          type: 'button',
          onclick: () => {
            draft.devices = draft.devices.filter((d) => d.deviceId !== device.id);
            select(null);
          },
        }, 'Remove from plan'),
        tray,
      ];
    }
    if (selected?.type === 'room' && editing()) {
      const room = draft.rooms.find((r) => r.id === selected.id);
      if (!room) return null;
      return [
        h('div.stage-panel-head', {}, h('strong', {}, 'Room'), close),
        h('label.field', {}, 'Name', h('input', {
          value: room.name,
          maxLength: 80,
          oninput: (e) => {
            room.name = e.target.value;
          },
          onchange: () => build(),
        })),
        h('button.icon-button.danger', {
          type: 'button',
          onclick: () => {
            draft.rooms = draft.rooms.filter((r) => r.id !== room.id);
            for (const d of draft.devices) if (d.roomId === room.id) d.roomId = null;
            select(null);
          },
        }, 'Delete room'),
        tray,
      ];
    }
    return tray ? [tray] : null;
  }

  function shownDevicesNotIn(p) {
    const placedIds = new Set(p.devices.map((d) => d.deviceId));
    const pool = deviceIds ? shownDevices() : [...devices.values()];
    return pool.filter((d) => !placedIds.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  }

  function placeDevice(device) {
    const room = selected?.type === 'room' ? draft.rooms.find((r) => r.id === selected.id) : null;
    const rooms = draft.rooms.filter((r) => r.floor === floor);
    const b = bounds(rooms);
    const [x, z] = room ? centroid(room.points) : [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
    draft.devices.push({
      deviceId: device.id,
      roomId: room?.id ?? roomAt(draft, x, z, floor)?.id ?? null,
      position: [snap(x, 0.05), defaultHeight(device), snap(z, 0.05)],
    });
    select({ type: 'device', id: device.id });
  }

  function startEditing() {
    draft = structuredClone(saved);
    // Keep the guessed positions so saving stores them.
    for (const [deviceId, place] of placements()) {
      if (!place.placed) draft.devices.push({ deviceId, roomId: place.roomId, position: place.position });
    }
    mode = draft.rooms.length ? 'move' : 'draw';
    select(null);
  }

  function cancelEditing() {
    draft = null;
    mode = 'move';
    select(null);
  }

  async function save() {
    const button = toolbar.querySelector('.primary');
    button.disabled = true;
    try {
      const plan = { ...draft, rooms: draft.rooms.map((r) => ({ ...r, name: r.name.trim() || 'Room' })) };
      saved = await onSave(plan);
      draft = null;
      mode = 'move';
      select(null);
      toast('Floor plan saved');
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  }

  return {
    el,
    /** A device's state or details changed. */
    update(device) {
      if (deviceObjects.has(device.id)) refreshDevice(device);
    },
    /** The stored plan changed (here or elsewhere). Edits in progress are kept. */
    setPlan(next) {
      saved = next;
      if (!editing()) build();
    },
    setDevices(ids, nextHints = new Map()) {
      deviceIds = ids;
      hints = nextHints;
      if (colors) build();
    },
    destroy() {
      cancelAnimationFrame(frame);
      resizer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      clearWorld();
      controls.dispose();
      renderer.dispose();
      renderer = null;
    },
  };
}

function floorName(f) {
  if (f === 0) return 'Ground floor';
  if (f < 0) return f === -1 ? 'Basement' : `Basement ${-f}`;
  return `Floor ${f}`;
}
