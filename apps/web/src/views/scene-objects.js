import * as THREE from 'three';
import { OBJECT_CATALOG, OBJECT_TYPES } from '../../../../packages/shared/src/objects.js';
import { h } from '../ui.js';
import { field } from './auth.js';
import { selectField } from './value-fields.js';

/** Build a furniture mesh with original, low-poly parts and editable dimensions and finish. */
export function makeObject(object) {
  const group = new THREE.Group();
  const shape = OBJECT_TYPES.get(object.type)?.shape;
  const main = new THREE.Color(object.color);
  const dark = main.clone().multiplyScalar(.55);
  const pale = main.clone().lerp(new THREE.Color('#fff4e6'), .55);
  const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: .72 });
  const materials = [mat(main), mat(dark), mat(pale)];
  function part(geometry, x, y, z, finish = 0) {
    const mesh = new THREE.Mesh(geometry, materials[finish]);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }
  const box = (w, height, d, x = 0, y = height / 2, z = 0, finish = 0) =>
    part(new THREE.BoxGeometry(w, height, d), x, y, z, finish);
  const tube = (top, base, height, x, y, z, finish = 0) =>
    part(new THREE.CylinderGeometry(top, base, height, 12), x, y, z, finish);
  const sphere = (x, y, z, w, height, d, finish = 0) => {
    const mesh = part(new THREE.SphereGeometry(.5, 12, 8), x, y, z, finish);
    mesh.scale.set(w, height, d);
    return mesh;
  };
  const legs = (height, w = .065, x = .39, z = .37) => {
    for (const a of [-x, x]) for (const b of [-z, z]) box(w, height, w, a, height / 2, b, 1);
  };
  const seat = (height = .49) => { legs(height); box(.95, .13, .95, 0, height, 0); };
  const cabinet = (height = .94) => { box(.96, height, .9); box(.99, .035, .97, 0, height + .017, 0, 2); };
  const panel = (size = .7, height = .7, y = .56) => box(size, height, .035, 0, y, .468, 1);
  const bed = (bottom, height) => {
    box(1, .1, 1, 0, bottom, 0, 1); box(.94, .18, .94, 0, bottom + .13, 0);
    box(.75, .07, .19, 0, bottom + .25, -.33, 2); box(1, height, .08, 0, height / 2, -.46, 1);
  };
  if (['chair', 'office', 'armchair', 'bench', 'stool'].includes(shape)) {
    seat(shape === 'bench' ? .87 : shape === 'stool' ? .86 : .48);
    if (['chair', 'office', 'armchair'].includes(shape)) box(.91, .48, .13, 0, .75, -.4);
    if (['armchair', 'office'].includes(shape)) for (const x of [-.42, .42]) box(.14, .23, .68, x, .62, 0, 2);
  } else if (['sofa', 'sectional', 'lounger'].includes(shape)) {
    box(.98, .36, .92, 0, .22, 0, 1);
    box(.82, .18, .79, 0, .46, .045); box(.96, .42, .19, 0, .77, -.37);
    if (shape !== 'lounger') for (const x of [-.43, .43]) box(.13, .35, .8, x, .57, .035);
    if (shape === 'sectional') box(.4, .18, .56, -.24, .46, .22, 2);
  } else if (['table', 'round-table', 'desk', 'vanity', 'island'].includes(shape)) {
    const height = shape === 'vanity' ? .52 : .92;
    if (shape === 'round-table') {
      tube(.49, .49, .08, 0, .95, 0); tube(.055, .17, .9, 0, .46, 0, 1);
    } else {
      if (shape === 'island') box(.86, .89, .86, 0, .447, 0, 1);
      else legs(height);
      box(1, .075, 1, 0, height + .04, 0);
      if (shape === 'desk' || shape === 'vanity') box(.28, .2, .58, .31, height - .1, .1, 1);
      if (shape === 'vanity') box(.67, .42, .04, 0, .78, -.44, 2);
    }
  } else if (['shelf', 'open-shelf', 'cabinet', 'drawers', 'display-case', 'fridge', 'dishwasher', 'washer', 'range', 'screen-box', 'sink'].includes(shape)) {
    if (['shelf', 'open-shelf', 'display-case'].includes(shape)) {
      for (const x of [-.46, .46]) box(.07, 1, .92, x);
      const levels = shape === 'open-shelf' ? [0.08, .91] : [.05, .31, .61, .94];
      for (const y of levels) box(.97, .065, .92, 0, y, 0, 2);
      if (shape === 'display-case') panel(.78, .65, .54);
    } else {
      cabinet();
      if (shape === 'drawer' || shape === 'drawers' || shape === 'fridge' || shape === 'cabinet') {
        const levels = shape === 'drawers' ? [.24, .49, .74] : [.25, .73];
        for (const y of levels) { box(.88, .023, .025, 0, y, .46, 1); box(.24, .045, .06, 0, y + .07, .48, 2); }
      } else if (shape === 'washer') {
        const door = tube(.29, .29, .06, 0, .47, .46, 1);
        door.rotation.x = Math.PI / 2;
      } else if (shape === 'sink') {
        box(.62, .012, .54, 0, .974, .02, 1); tube(.035, .035, .18, 0, .89, -.33, 2);
      } else {
        panel(.76, .58, .51);
        if (shape === 'range') for (const x of [-.24, .24]) for (const z of [-.23, .23]) tube(.13, .13, .018, x, .98, z, 1);
      }
    }
  } else if (['bed', 'bunk', 'crib'].includes(shape)) {
    bed(.23, shape === 'bunk' ? .98 : .9);
    if (shape === 'bunk') { bed(.71, .93); box(.07, .95, .08, .44, .47, .42, 1); }
    if (shape === 'crib') for (const x of [-.44, .44]) {
      box(.06, .055, .96, x, .92, 0, 1);
      for (const z of [-.44, -.22, 0, .22, .44]) box(.04, .56, .04, x, .64, z, 2);
    }
  } else if (['lamp', 'pendant', 'sconce'].includes(shape)) {
    const pendant = shape === 'pendant';
    tube(.21, .24, .06, 0, .04, 0, 1);
    tube(.035, .035, .73, 0, .39, 0, 1);
    tube(pendant ? .16 : .29, .46, .27, 0, pendant ? .25 : .82, 0);
  } else if (shape === 'plant' || shape === 'planter') {
    if (shape === 'plant') tube(.32, .25, .32, 0, .16, 0, 1);
    else box(.97, .42, .95, 0, .21, 0, 1);
    for (const [x, y, z] of [[-.2, .58, -.15], [.17, .7, .05], [0, .79, -.12], [.1, .58, .16]]) sphere(x, y, z, .44, .4, .48);
  } else if (shape === 'tub' || shape === 'shower') {
    const height = shape === 'tub' ? .83 : .08;
    box(.98, .08, .98, 0, .05, 0, 2);
    box(.08, height, .94, -.44); box(.08, height, .94, .44);
    box(.88, height, .08, 0, height / 2, -.44); box(.88, height, .08, 0, height / 2, .44);
    if (shape === 'shower') for (const x of [-.43, .43]) box(.025, .9, .025, x, .5, -.43);
  } else if (shape === 'toilet') {
    sphere(0, .33, .16, .8, .46, .62, 2); tube(.25, .31, .23, 0, .12, .14);
    box(.82, .56, .31, 0, .68, -.3);
  } else if (shape === 'tv') {
    box(.96, .72, .13, 0, .62, 0); box(.9, .65, .02, 0, .62, .072, 1);
    box(.11, .23, .12, 0, .16, 0); box(.46, .05, .72);
  } else if (shape === 'bike') {
    for (const z of [-.32, .32]) {
      const wheel = part(new THREE.TorusGeometry(.24, .035, 8, 16), 0, .27, z, 1);
      wheel.rotation.y = Math.PI / 2;
    }
    box(.11, .08, .6, 0, .43, 0); box(.09, .45, .06, 0, .48, -.3); box(.58, .07, .09, 0, .73, -.31);
    box(.1, .3, .06, 0, .54, .13); box(.28, .08, .21, 0, .71, .13, 1);
  } else if (shape === 'grill' || shape === 'coffee') {
    legs(.62); box(.88, .3, .83, 0, .76, 0);
    box(.44, .055, .17, 0, .82, .41, 1);
  } else if (shape === 'rack' || shape === 'radiator' || shape === 'divider') {
    box(.06, .95, .5, -.44); box(.06, .95, .5, .44);
    for (const y of [.15, .31, .47, .63, .8, .93]) box(.88, .065, .29, 0, y, 0, y > .7 ? 2 : 0);
  } else if (shape === 'round-rug' || shape === 'pouf' || shape === 'basket') {
    tube(.48, .45, .9, 0, .45, 0); tube(.48, .48, .07, 0, .93, 0, 2);
  } else {
    box(.98, .98, .94);
    if (shape === 'speaker') { panel(.76, .79); sphere(0, .71, .47, .37, .22, .04, 2); sphere(0, .31, .47, .55, .33, .04, 2); }
    if (shape === 'mirror') box(.87, .85, .055, 0, .5, .455, 2);
    if (shape === 'rug') box(.9, .08, .85, 0, .96, 0, 2);
  }
  const used = new Set(group.children.map((mesh) => mesh.material));
  for (const material of materials) if (!used.has(material)) material.dispose();
  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  for (const mesh of group.children) mesh.position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
  group.scale.set(object.size[0] / size.x, object.size[1] / size.y, object.size[2] / size.z);
  group.position.set(...object.position);
  group.rotation.y = THREE.MathUtils.degToRad(object.rotation);
  return group;
}

/** Browse and add catalog objects by category or name. */
export function openObjectBrowser(add) {
  const categories = [...new Set(OBJECT_CATALOG.map((object) => object.category))];
  let category = categories[0];
  let query = '';
  const grid = h('div.object-catalog');
  const dialog = h('dialog.panel.wide', { 'aria-label': 'Object browser' },
    h('header', {}, h('h2', {}, 'Object browser'),
      h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕')),
    h('div.settings-fields', {},
      field('Search objects', h('input', { type: 'search', oninput: (e) => { query = e.target.value.trim().toLowerCase(); render(); } })),
      selectField('Category', [['', 'All objects'], ...categories.map((item) => [item, item])], category, (item) => {
        category = item;
        render();
      }), grid));
  const thumbnails = new Map();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }); } catch { /* use text */ }
  renderer?.setSize(120, 86);

  function thumbnail(object) {
    if (!renderer) return null;
    if (!thumbnails.has(object.id)) {
      const scene = new THREE.Scene();
      const mesh = makeObject({ ...object, type: object.id, position: [0, 0, 0], rotation: 0 });
      const size = Math.max(...object.size);
      const camera = new THREE.PerspectiveCamera(34, 120 / 86, .01, 100);
      camera.position.set(size * 1.5, size * 1.21, size * 1.75);
      camera.lookAt(0, object.size[1] / 2, 0);
      scene.add(mesh, new THREE.HemisphereLight(0xf9faff, 0x6e767b, 2.5));
      const sun = new THREE.DirectionalLight(0xfff0db, 1.7);
      sun.position.set(2, 4, 3);
      scene.add(sun);
      renderer.render(scene, camera);
      thumbnails.set(object.id, renderer.domElement.toDataURL());
      const materials = new Set();
      mesh.traverse((item) => { item.geometry?.dispose(); if (item.material) materials.add(item.material); });
      for (const material of materials) material.dispose();
    }
    return h('img', { src: thumbnails.get(object.id), width: 120, height: 86, alt: '' });
  }

  function render() {
    const items = OBJECT_CATALOG.filter((object) => query ? object.name.toLowerCase().includes(query) : !category || object.category === category);
    grid.replaceChildren(...items.map((object) => h('button.object-choice', {
      type: 'button', onclick: () => { add(object); dialog.close(); },
    }, thumbnail(object), h('span', {}, object.name))));
    if (!items.length) grid.append(h('p.muted', {}, 'No matching objects.'));
  }
  dialog.addEventListener('close', () => { renderer?.dispose(); dialog.remove(); });
  render();
  document.body.append(dialog);
  dialog.showModal();
}
