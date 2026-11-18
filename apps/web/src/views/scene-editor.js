import { DISPLAYS, NUMERIC_DISPLAYS } from '../../../../packages/shared/src/floorplan.js';
import { displayCapabilities, displayRange } from '../floorplan-visuals.js';
import { deviceIcon, labelFor } from '../controls.js';
import { h, toast } from '../ui.js';
import { field } from './auth.js';
import { selectField, valueField } from './value-fields.js';

const CLICK_CHOICES = [
  ['details', 'Open full device card'], ['command', 'Send device command'], ['action', 'Run a saved action'],
  ['message', 'Show a message'], ['none', 'Do nothing'],
];
const DISPLAY_COLORS = ['color', 'badge', 'threshold', 'status'];
const FALLBACKS = { floorColor: '#9a9eaa', wallColor: '#838999', edgeColor: '#525a6a' };

/** Device fields for its appearance and one-click behavior on the shared plan. */
export function placementEditor(placement, device, actions, preview) {
  const appearance = h('div.settings-fields');
  const interaction = h('div.settings-fields');

  function appearanceFields() {
    const display = placement.display ?? { mode: 'auto' };
    const choices = displayCapabilities(device, display.mode);
    const cap = choices.find((item) => item.property === display.property) ?? choices[0];
    const [min, max] = displayRange({}, cap);
    const numeric = NUMERIC_DISPLAYS.includes(display.mode);
    const modes = Object.entries(DISPLAYS).filter(([mode]) =>
      mode === display.mode || ['auto', 'icon'].includes(mode) || displayCapabilities(device, mode).length > 0);
    appearance.replaceChildren(...[
      selectField('Display style', modes, display.mode, (mode) => {
        if (mode === 'auto') delete placement.display;
        else {
          const property = displayCapabilities(device, mode).find((item) => item.property === display.property)?.property;
          placement.display = { ...display, mode, property };
        }
        appearanceFields();
        preview();
      }),
      ['auto', 'icon'].includes(display.mode) ? null : selectField('Reading',
        choices.map((item) => [item.property, labelFor(item)]), display.property ?? cap?.property, (property) => {
          Object.assign(display, { property, min: undefined, max: undefined, threshold: undefined });
          appearanceFields();
          preview();
        }),
      numeric && display.mode !== 'trend' ? h('div.scene-fields-pair', {},
        numberField('Scale minimum', display, 'min', { placeholder: display.mode === 'chart' ? 'Automatic' : String(min) }, preview),
        numberField('Scale maximum', display, 'max', { placeholder: display.mode === 'chart' ? 'Automatic' : String(max) }, preview),
      ) : null,
      display.mode === 'threshold' ? numberField('Threshold', display, 'threshold', { placeholder: String((min + max) / 2) }, preview) : null,
      DISPLAY_COLORS.includes(display.mode) ? h('div.scene-fields-pair', {},
        colorField(display.mode === 'status' ? 'Off color' : 'Low color', display, 'lowColor', '#559aed', preview),
        colorField(display.mode === 'status' ? 'On color' : 'High color', display, 'highColor', '#f57850', preview),
      ) : null,
    ].filter(Boolean));
  }

  function interactionFields() {
    const click = placement.click ?? { mode: 'details' };
    const modes = CLICK_CHOICES.filter(([mode]) => mode !== 'command' || click.mode === 'command' ||
      device.capabilities.some((c) => c.writable));
    interaction.replaceChildren(...[
      selectField('When clicked', modes, click.mode, (mode) => {
        if (mode === 'details') delete placement.click;
        else placement.click = mode === 'command' ? { mode, values: {} } : { mode };
        interactionFields();
      }),
      click.mode === 'command' ? commandFields(click.values) : null,
      click.mode === 'action' ? selectField('Action to run', actions.map((a) => [a.id, a.name]), click.actionId,
        (id) => { click.actionId = id; }, { placeholder: 'Choose an action', required: true }) : null,
      click.mode === 'message' ? field('Message in HomeyVibe', h('input', {
        value: click.message ?? '', maxLength: 200, required: true, oninput: (e) => { click.message = e.target.value; },
      })) : null,
    ].flat().filter(Boolean));
  }

  function commandFields(values) {
    const writable = device.capabilities.filter((cap) => cap.writable);
    const addable = writable.filter((cap) => !Object.hasOwn(values, cap.property));
    return [
      ...Object.entries(values).map(([key, value]) => h('div.scene-command', {},
        valueField(writable.find((cap) => cap.property === key), key, value, (next) => { values[key] = next; }),
        h('button.icon-button', {
          type: 'button', 'aria-label': `Remove ${key}`, onclick: () => { delete values[key]; interactionFields(); },
        }, '✕'),
      )),
      selectField('Add command setting', addable.map((cap) => [cap.property, labelFor(cap)]), '', (property) => {
        if (!property) return;
        const cap = addable.find((item) => item.property === property);
        values[property] = cap.valueOn ?? cap.values?.[0] ?? cap.min ??
          (cap.type === 'numeric' ? 0 : cap.type === 'text' ? '' : undefined);
        interactionFields();
      }, { placeholder: 'Choose a writable control', disabled: !addable.length, required: !Object.keys(values).length }),
    ];
  }

  appearanceFields();
  interactionFields();
  const light = placement.light ?? {};
  const updateLight = () => { placement.light = light; preview(); };
  return [
    group('Display', appearance, true),
    group('Click behavior', interaction),
    deviceIcon(device) === 'light' ? group('Room lighting',
      h('div.settings-fields', {},
        checkbox('Light up the room when on', light.enabled !== false, (enabled) => { light.enabled = enabled; updateLight(); }),
        numberField('Light strength', light, 'strength', { min: 0, max: 2, step: 0.1, placeholder: '1' }, updateLight),
        colorField('Light color', light, 'color', '#ffc977', updateLight),
      )) : null,
  ];
}

/** Room finish, visible wall edges, and real door/window cut-outs. */
export function roomEditor(room, preview) {
  room.style ??= {};
  room.openings ??= [];
  const style = room.style;
  const finishes = h('div.settings-fields');
  const openings = h('div.settings-fields');
  const walls = room.points.map(([x, z], i) => {
    const [nextX, nextZ] = room.points[(i + 1) % room.points.length];
    return Math.hypot(nextX - x, nextZ - z);
  });

  function finishFields() {
    finishes.replaceChildren(
      h('div.scene-fields-pair', {},
        colorField('Floor color', style, 'floorColor', FALLBACKS.floorColor, preview),
        colorField('Wall color', style, 'wallColor', FALLBACKS.wallColor, preview),
        checkbox('Show edge outlines', style.edges === true, (edges) => { style.edges = edges; preview(); }),
        colorField('Edge color', style, 'edgeColor', FALLBACKS.edgeColor, () => { style.edges = true; finishFields(); preview(); }),
      ),
      h('div.scene-fields-pair', {},
        numberField('Room height (m)', room, 'height', { min: 1, max: 20, required: true }, preview),
        numberField('Visible wall height (m)', style, 'wallHeight', { min: 0.2, max: room.height, placeholder: 'Automatic' }, preview),
        numberField('Wall thickness (m)', style, 'wallThickness', { min: 0.02, max: 1, placeholder: '0.08' }, preview),
        numberField('Wall opacity', style, 'wallOpacity', { min: 0, max: 1, step: 0.05, placeholder: '0.4' }, preview),
      ),
      h('button.icon-button', { type: 'button', onclick: () => {
        for (const key of Object.keys(FALLBACKS)) delete style[key];
        finishFields();
        preview();
      } }, 'Use theme colors'),
    );
  }

  function openingFields() {
    openings.replaceChildren(
      ...room.openings.map((opening, i) => h('fieldset.config-group.settings-fields', {},
        h('legend', {}, `${opening.type === 'door' ? 'Door' : 'Window'} ${i + 1}`),
        selectField('Wall', walls.map((length, index) => [String(index), `Wall ${index + 1} · ${length.toFixed(2)} m`]),
          String(opening.edge), (edge) => { opening.edge = Number(edge); openingFields(); preview(); }),
        h('div.scene-fields-pair', {},
          numberField('Offset from wall start (m)', opening, 'offset', { min: 0, required: true }, preview),
          numberField('Width (m)', opening, 'width', { min: 0.1, max: walls[opening.edge]?.toFixed(3), required: true }, preview),
          numberField('Height (m)', opening, 'height', { min: 0.1, max: room.height, required: true }, preview),
          opening.type === 'window' ? numberField('Sill height (m)', opening, 'bottom', { min: 0, max: room.height, required: true }, preview) : null,
        ),
        h('button.icon-button', { type: 'button', onclick: () => {
          room.openings.splice(i, 1);
          openingFields();
          preview();
        } }, `Remove ${opening.type}`),
      )),
      h('div.row', {}, ['door', 'window'].map((type) =>
        h('button', { type: 'button', onclick: () => addOpening(type) }, `Add ${type}`))),
    );
  }

  function addOpening(type) {
    for (const [edge, length] of walls.entries()) {
      const width = Math.min(type === 'door' ? 0.9 : 1.2, Math.floor(length * 80) / 100);
      if (width < 0.2) continue;
      let offset = 0.1;
      const present = room.openings.filter((o) => o.edge === edge).sort((a, b) => a.offset - b.offset);
      for (const previous of present) {
        if (offset + width + 0.1 <= previous.offset) break;
        offset = Math.max(offset, previous.offset + previous.width + 0.1);
      }
      if (offset + width > length) continue;
      const bottom = type === 'window' ? Math.min(0.8, room.height / 2) : 0;
      const height = Math.min(type === 'door' ? 2 : 1, room.height - bottom);
      room.openings.push({ type, edge, offset: Math.round(offset * 1000) / 1000, width, bottom, height });
      openingFields();
      preview();
      return;
    }
    toast('Choose a larger wall or make space between existing openings.');
  }

  finishFields();
  openingFields();
  return [group('Room finishes', finishes, true), group('Doors and windows', openings)];
}

function group(label, content, open = false) {
  return h('details.scene-editor-group', { open }, h('summary', {}, label), content);
}

function numberField(label, target, key, props, preview) {
  return field(label, h('input', {
    type: 'number', step: 'any', value: target[key] ?? '', ...props,
    oninput: (e) => {
      const value = e.target.valueAsNumber;
      if (e.target.value === '' && !e.target.validity.badInput) delete target[key];
      else if (Number.isFinite(value)) target[key] = value;
    },
    onchange: preview,
  }));
}

function colorField(label, target, key, fallback, preview) {
  return field(label, h('input', { type: 'color', value: target[key] ?? fallback,
    onchange: (e) => { target[key] = e.target.value; preview(); } }));
}

function checkbox(label, checked, change) {
  return h('label.row', {}, h('input', { type: 'checkbox', checked, onchange: (e) => change(e.target.checked) }), label);
}
