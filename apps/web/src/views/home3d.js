// 3D page: the home's floor plan with live devices. Loaded on demand so three.js stays out of the main bundle.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { deviceIcon } from '../controls.js';
import { h, toast } from '../ui.js';
import {
  ICONS, autoPlace, bounds, centroid, defaultHeight, floorsOf, lightLevel, roomAt, snap,
} from '../floorplan.js';
import { arrangeMarkers, markerReading, mergeHistory } from '../floorplan-visuals.js';
import { placementEditor, roomEditor } from './scene-editor.js';
import { addWalls } from './scene-walls.js';
import { HIGH_COLOR, LOW_COLOR, renderMarker } from './scene-markers.js';

const CLICK_SLOP_PX = 6;
const FALLBACK_DISPLAY = { mode: 'auto' };

/**
 * @param {object} opts
 * @param {object} opts.plan floor plan { rooms, devices }
 * @param {Map<string, object>} opts.devices all known devices by id (kept live by the dashboard)
 * @param {string[]|null} opts.deviceIds devices this page shows; null = every placed device
 * @param {Map<string,string>} [opts.hints] deviceId -> text that may name its room (section titles)
 * @param {boolean} opts.canEdit may change the floor plan
 * @param {boolean} opts.canControl may use a device preset or action
 * @param {(device: object) => HTMLElement} opts.renderCard the dashboard's device card
 * @param {(plan: object) => Promise<object>} opts.onSave saves the plan, resolves with the stored plan
 * @param {() => object[]} opts.listActions current actions by their dashboard order
 * @param {(id: string, property: string) => Promise<{points: number[][]}>} opts.fetchHistory
 * @param {(id: string, values: object) => Promise<object>} opts.sendCommand
 * @param {(id: string) => Promise<{ok: boolean, error?: string}>} opts.runAction
 */
export function createHome3d({
  plan, devices, deviceIds, hints = new Map(), canEdit, canControl, renderCard, onSave,
  listActions, fetchHistory, sendCommand, runAction,
}) {
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
  const deviceObjects = new Map();
  const roomMeshes = new Map();
  const history = new Map();
  const busy = new Set();
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

  function placementOf(id) {
    return current().devices.find((entry) => entry.deviceId === id);
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
    const materials = new Set();
    world.traverse((obj) => {
      obj.geometry?.dispose();
      for (const material of [].concat(obj.material ?? [])) materials.add(material);
      if (obj.isCSS2DObject) obj.element.remove();
    });
    for (const material of materials) material.dispose();
    world.clear();
    deviceObjects.clear();
    roomMeshes.clear();
  }

  function build(renderEditor = true) {
    if (!renderer) return;
    colors ??= readColors();
    clearWorld();
    const rooms = current().rooms.filter((r) => r.floor === floor);

    for (const room of rooms) {
      const shape = new THREE.Shape(room.points.map(([x, z]) => new THREE.Vector2(x, -z)));
      const isSelected = selected?.type === 'room' && selected.id === room.id;
      const finish = room.style ?? {};
      const floorColor = finish.floorColor ? new THREE.Color(finish.floorColor) : colors.floor.clone();
      if (isSelected) floorColor.lerp(colors.accent, 0.25);
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.9 }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.userData.roomId = room.id;
      world.add(mesh);
      roomMeshes.set(room.id, mesh);
      if (finish.edges) {
        const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
          room.points.map(([x, z]) => new THREE.Vector3(x, 0.008, z))),
        new THREE.LineBasicMaterial({ color: finish.edgeColor ?? colors.line }));
        world.add(outline);
      }
      const [cx, cz] = centroid(room.points);
      const label = new CSS2DObject(h('span.room-label', {}, room.name));
      label.position.set(cx, 0.02, cz);
      world.add(label);
    }

    addWalls(world, rooms, colors, editing() && selected?.type === 'room' ? selected.id : null);

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
    for (const roomId of roomMeshes.keys()) refreshRoomLight(roomId);
    if (renderEditor) {
      renderToolbar();
      renderPanel();
    }
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
      const room = current().rooms.find((r) => r.id === place.roomId);
      const b = room ? bounds([room]) : null;
      const distance = b ? Math.max(3, Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ)) : 5;
      light = new THREE.PointLight(0xffc977, 0, distance, 2);
      light.position.y = y;
      group.add(light);
    }

    const labelButton = h('button.device-label', {
      type: 'button', dataset: { deviceId: device.id },
      onpointerdown: (event) => onPointerDown(event, device.id),
      onclick: (event) => { if (event.detail === 0) activate(device.id); },
    });
    const details = h('button.device-label-details', {
      type: 'button', 'aria-label': `Open ${device.name} details`, title: 'Open full device card',
      onclick: () => select({ type: 'device', id: device.id }),
    }, 'i');
    const label = new CSS2DObject(h('div.scene-marker', {}, labelButton, details));
    label.position.y = y + 0.28;
    group.add(label);

    world.add(group);
    const entry = { group, mesh, label, labelButton, details, light, stem, kind, roomId: place.roomId };
    deviceObjects.set(device.id, entry);
    refreshDevice(device, false);
  }

  function refreshDevice(device, changes) {
    const entry = deviceObjects.get(device.id);
    if (!entry) return;
    const placement = placementOf(device.id);
    const display = placement?.display ?? FALLBACK_DISPLAY;
    const lighting = placement?.light ?? {};
    const level = lightLevel(device);
    const material = entry.mesh.material;
    const isSelected = selected?.type === 'device' && selected.id === device.id;
    const labelButton = entry.labelButton;
    labelButton.classList.toggle('selected', isSelected);
    labelButton.classList.toggle('on', level !== null && level > 0);
    const mode = placement?.click?.mode ?? 'details';
    labelButton.title = editing() ? 'Edit device' : ({
      details: 'Open full device card', command: 'Send device command',
      action: 'Run saved action', message: 'Show a message', none: 'Device reading',
    })[mode];
    entry.details.hidden = editing() || mode === 'details';
    labelButton.setAttribute('aria-busy', String(busy.has(device.id)));
    const points = ['chart', 'trend'].includes(display.mode) ? readingHistory(device, display, changes) : [];
    const { fraction, active } = renderMarker(labelButton, device, entry.kind, display, points);
    material.color.copy(device.available === false ? colors.muted : colors.accent);
    material.emissive.set(0x000000);
    material.emissiveIntensity = 0;
    if (level !== null) {
      const lightColor = lighting.color ?? '#ffc977';
      material.color.set(level > 0 ? lightColor : colors.muted);
      material.emissive.set(lightColor);
      material.emissiveIntensity = level * 1.5;
      entry.light.color.set(lightColor);
      entry.level = lighting.enabled === false ? 0 : level * (lighting.strength ?? 1);
      entry.light.intensity = entry.level * 6;
    }
    if (device.available !== false) {
      const low = display.lowColor ?? LOW_COLOR;
      const high = display.highColor ?? HIGH_COLOR;
      if (['color', 'badge'].includes(display.mode) && fraction !== null) {
        material.color.set(low).lerp(new THREE.Color(high), fraction);
      } else if (active !== null) {
        material.color.set(active ? high : low);
      }
    }
    if (entry.light && changes !== false) refreshRoomLight(entry.roomId);
    requestRender();
  }

  function readingHistory(device, display, changes) {
    const { cap, value } = markerReading(device, display);
    if (!cap) return [];
    const key = JSON.stringify([device.id, cap.property]);
    let series = history.get(key);
    if (!series) {
      series = { points: [] };
      history.set(key, series);
      fetchHistory(device.id, cap.property).then(({ points }) => {
        series.points = mergeHistory([points, series.points]);
        if (renderer && devices.has(device.id)) refreshDevice(devices.get(device.id));
      }).catch(() => {
        // Live reports still populate the chart. A new scene will try to load its history again.
      });
    }
    if (changes && Object.hasOwn(changes, cap.property) && Number.isFinite(value)) {
      series.points = mergeHistory([series.points, [[Date.now(), value]]]);
    }
    return series.points;
  }

  function refreshRoomLight(roomId) {
    const floorMesh = roomMeshes.get(roomId);
    if (!floorMesh) return;
    const hue = new THREE.Color(0);
    let amount = 0;
    for (const { light, level, roomId: inRoom } of deviceObjects.values()) {
      if (inRoom !== roomId || !light || !level) continue;
      hue.r += light.color.r * level;
      hue.g += light.color.g * level;
      hue.b += light.color.b * level;
      amount += level;
    }
    if (amount) hue.multiplyScalar(1 / amount);
    floorMesh.material.emissive.copy(hue);
    floorMesh.material.emissiveIntensity = Math.min(0.65, amount * 0.30);
  }

  async function activate(id) {
    const device = devices.get(id);
    if (!device) return;
    const click = placementOf(id)?.click;
    if (editing() || !click || click.mode === 'details') return select({ type: 'device', id });
    if (click.mode === 'none') return;
    if (click.mode === 'message') return toast(click.message);
    if (!canControl || device.access === 'view') return select({ type: 'device', id });
    if (busy.has(id)) return;
    busy.add(id);
    deviceObjects.get(id)?.labelButton.setAttribute('aria-busy', 'true');
    try {
      if (click.mode === 'command') {
        if (device.available === false) throw new Error(`${device.name} is offline`);
        await sendCommand(id, click.values);
        toast(`Command sent to ${device.name}`);
      } else if (click.mode === 'action') {
        const result = await runAction(click.actionId);
        if (result.ok) toast(`Ran ${listActions().find((action) => action.id === click.actionId)?.name ?? click.actionId}`);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      busy.delete(id);
      deviceObjects.get(id)?.labelButton.setAttribute('aria-busy', 'false');
    }
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
    const wallHeight = Math.max(1, ...rooms.map((room) => room.style?.wallHeight ??
      Math.max(1, ...(room.openings ?? []).map((opening) => opening.bottom + opening.height))));
    const depth = Math.max(b.maxZ - b.minZ, 3) + wallHeight;
    const distance = Math.max(width / (2 * Math.tan(hHalf)), depth / (2 * Math.tan(vHalf))) * 1.1;
    const targetY = Math.max(0, (wallHeight - 1) / 3);
    controls.target.set(cx, targetY, cz);
    camera.position.set(cx, targetY + distance * 0.78, cz + distance * 0.63);
    controls.update();
    fitted = true;
    requestRender();
  }

  // ---- rendering --------------------------------------------------------------------------

  let frame = 0;
  const projected = new THREE.Vector3();

  function placeMarkers() {
    const { width, height } = labels.getSize();
    const markers = [];
    for (const { label } of deviceObjects.values()) {
      const w = label.element.offsetWidth;
      const h = label.element.offsetHeight;
      if (!w || !h) continue;
      projected.setFromMatrixPosition(label.matrixWorld).project(camera);
      const x = (projected.x + 1) * width / 2;
      const y = (1 - projected.y) * height / 2;
      if (x < -w || x > width + w || y < -h || y > height + h) {
        label.center.set(0.5, 0.5);
        continue;
      }
      markers.push({ label, x, y, w, h });
    }
    arrangeMarkers(markers, width, height).forEach(([x, y], i) => markers[i].label.center.set(x, y));
  }

  function requestRender() {
    if (frame || !renderer) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const moving = controls.update();
      renderer.render(scene, camera);
      // The first CSS pass after building inserts labels so their real size can be measured.
      if ([...deviceObjects.values()].some(({ label }) => !label.element.isConnected)) labels.render(scene, camera);
      placeMarkers();
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
    return raycaster.intersectObjects([...roomMeshes.values()])[0]?.object.userData.roomId ?? null;
  }

  function onPointerDown(e, labelDeviceId = null) {
    if (e.button !== 0 || gesture) return;
    const deviceId = labelDeviceId ?? pickDevice(e);
    gesture = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, deviceId, moved: false, kind: 'click' };
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
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > CLICK_SLOP_PX) gesture.moved = true;
    if (!gesture.moved) return;
    const p = groundPoint(e);
    if (!p) return;
    if (gesture.kind === 'drag') {
      const entry = deviceObjects.get(gesture.deviceId);
      const placement = draft?.devices.find((d) => d.deviceId === gesture.deviceId);
      if (!entry || !placement) return;
      placement.position = [snap(p.x, 0.05), placement.position[1], snap(p.z, 0.05)];
      entry.group.position.set(placement.position[0], 0, placement.position[2]);
      requestRender();
    } else if (gesture.kind === 'draw') {
      gesture.end = [snap(p.x, 0.25), snap(p.z, 0.25)];
      drawPreview(gesture.start, gesture.end);
    }
  }

  function stopGesture() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    controls.enabled = true;
    const g = gesture;
    gesture = null;
    return g;
  }

  function onPointerCancel(e) {
    if (gesture?.pointerId !== e.pointerId) return;
    stopGesture();
    clearPreview();
  }

  function onPointerUp(e) {
    if (gesture?.pointerId !== e.pointerId) return;
    const g = stopGesture();
    if (g.kind === 'drag' && g.moved) {
      const placement = draft?.devices.find((d) => d.deviceId === g.deviceId);
      if (!placement) return;
      placement.roomId = roomAt(draft, placement.position[0], placement.position[2], floor)?.id ?? null;
      select({ type: 'device', id: g.deviceId });
      return;
    }
    if (g.kind === 'draw') {
      clearPreview();
      if (g.end && draft) addRoom(g.start, g.end);
      return;
    }
    if (g.moved) return; // the camera was dragged
    if (g.deviceId) activate(g.deviceId);
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
      h('select', {
        'aria-label': 'Select object',
        onchange: (e) => {
          const [type, id] = e.target.value.split(/:(.*)/s);
          if (id) select({ type, id });
        },
      },
      h('option', { value: '', selected: !selected }, 'Select object'),
      h('optgroup', { label: 'Rooms' }, current().rooms.filter((r) => r.floor === floor).map((r) =>
        h('option', { value: `room:${r.id}`, selected: selected?.type === 'room' && selected.id === r.id }, r.name))),
      h('optgroup', { label: 'Devices' }, [...deviceObjects.keys()].map((id) =>
        h('option', { value: `device:${id}`, selected: selected?.type === 'device' && selected.id === id }, devices.get(id).name)))),
      h('button.primary', { type: 'button', onclick: save }, 'Save'),
      h('button.icon-button', { type: 'button', onclick: cancelEditing }, 'Cancel'),
    );
    hint.hidden = false;
    hint.textContent = mode === 'draw'
      ? 'Drag on the floor to draw a rectangular room.'
      : 'Select a device or room to configure it. Drag devices to move them.';
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
        ...placementEditor(placement, device, listActions(), () => build(false)),
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
          onchange: () => build(false),
        })),
        ...roomEditor(room, () => build(false)),
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
    const invalid = [...panel.querySelectorAll('input, select')].find((control) => !control.checkValidity());
    if (invalid) {
      const section = invalid.closest('details');
      if (section) section.open = true;
      invalid.reportValidity();
      return;
    }
    if (draft.devices.some(({ click }) => click?.mode === 'command' &&
      (!Object.keys(click.values).length || Object.values(click.values).includes(undefined)))) {
      toast('Choose a value for every setting in each device command.');
      return;
    }
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
    update(device, changes) {
      if (deviceObjects.has(device.id)) refreshDevice(device, changes);
      if (!changes && !editing() && selected?.type === 'device' && selected.id === device.id) renderPanel();
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
      stopGesture();
      clearPreview();
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
