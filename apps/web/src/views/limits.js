import { api } from '../api.js';
import { deviceIcon, labelFor } from '../controls.js';
import { ICONS } from '../floorplan.js';
import { ACCESS_LABELS, entryFor, limitableCaps, parseRange } from '../limits.js';
import { h, toast } from '../ui.js';

/**
 * Edit what someone (a person, or the HomeyVibe AI) may see and control.
 * @param {object} opts
 * @param {string} opts.title e.g. "HomeyVibe AI" or a person's name
 * @param {object} opts.limits current { default, devices } (plus canControl/canConfigure for the AI)
 * @param {boolean} opts.isAi show the AI's own switches
 * @param {(limits: object) => Promise<object>} opts.onSave
 */
export async function openLimitsDialog({ title, limits, isAi, onSave }) {
  const devices = (await api.devices()).sort((a, b) => a.name.localeCompare(b.name));
  const rows = new Map(); // deviceId -> { access, inputs: [{ cap, min, max }] }

  const canControl = h('input', { type: 'checkbox', role: 'switch', className: 'toggle', checked: limits.canControl !== false });
  const canConfigure = h('input', { type: 'checkbox', role: 'switch', className: 'toggle', checked: limits.canConfigure !== false });
  const defaultSelect = h('select', { 'aria-label': 'New devices' },
    Object.entries(ACCESS_LABELS).map(([v, label]) => h('option', { value: v, selected: v === (limits.default ?? 'control') }, label)));
  const search = h('input', { type: 'search', placeholder: 'Find a device…', 'aria-label': 'Find a device' });
  const list = h('ul.limit-list');
  const error = h('p.form-error', { role: 'alert' });
  const save = h('button.primary', { type: 'button' }, 'Save');

  const dialog = h('dialog.panel.wide', { 'aria-labelledby': 'limits-title' },
    h('header', {},
      h('h2', { id: 'limits-title' }, `Limits for ${title}`),
      h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕'),
    ),
    h('p.muted', {}, isAi
      ? 'The AI acts for whoever is chatting with it or connected it, and never gets more than that person. These limits narrow it further.'
      : 'Choose which devices this person can see and control. Admins always have full access.'),
    isAi ? h('div.limit-switches', {},
      h('label.cap', {}, h('span', {}, 'Can control devices and run actions'), canControl),
      h('label.cap', {}, h('span', {}, 'Can change pages, actions and the floor plan'), canConfigure),
    ) : null,
    h('label.cap', {}, h('span', {}, 'New devices'), defaultSelect),
    search,
    list,
    error,
    h('div.row.end', {}, h('button.icon-button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), save),
  );
  dialog.addEventListener('close', () => dialog.remove());

  for (const device of devices) {
    const { access, ranges } = entryFor(limits, device.id);
    rows.set(device.id, { access, ranges, inputs: [] });
  }

  function renderRow(device) {
    const row = rows.get(device.id);
    const caps = limitableCaps(device);
    const name = `access-${device.id}`;
    const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': `Access to ${device.name}` },
      Object.entries(ACCESS_LABELS).map(([value, label]) => h('label', {},
        h('input', {
          type: 'radio',
          name,
          value,
          checked: row.access === value,
          onchange: () => {
            row.access = value;
            item.replaceWith(renderRow(device));
          },
        }),
        h('span', {}, label))));

    row.inputs = [];
    let rangesEl = null;
    if (row.access === 'control' && caps.length) {
      rangesEl = h('details.limit-ranges', { open: Object.keys(row.ranges).length > 0 },
        h('summary', {}, Object.keys(row.ranges).length ? 'Value limits' : 'Limit values'),
        caps.map((cap) => {
          const [lo, hi] = row.ranges[cap.property] ?? [];
          const step = cap.step ?? (Number.isInteger(cap.min) && Number.isInteger(cap.max) ? 1 : 0.1);
          const min = h('input', { type: 'number', inputMode: 'decimal', step, min: cap.min, max: cap.max, value: lo ?? '', placeholder: String(cap.min), 'aria-label': `${labelFor(cap)} lowest` });
          const max = h('input', { type: 'number', inputMode: 'decimal', step, min: cap.min, max: cap.max, value: hi ?? '', placeholder: String(cap.max), 'aria-label': `${labelFor(cap)} highest` });
          row.inputs.push({ cap, min, max });
          return h('div.range-row', {},
            h('span', {}, labelFor(cap)),
            h('span.range-inputs', {}, min, h('span.muted', {}, 'to'), max, cap.unit ? h('span.muted', {}, cap.unit) : null));
        }));
    }
    const item = h('li', { dataset: { deviceId: device.id, name: device.name.toLowerCase() } },
      h('div.limit-head', {},
        h('span.limit-name', {}, h('span', { 'aria-hidden': 'true' }, ICONS[deviceIcon(device)]), device.name),
        seg),
      rangesEl);
    return item;
  }

  list.replaceChildren(...devices.map(renderRow));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const li of list.children) li.hidden = Boolean(q) && !li.dataset.name.includes(q);
  });

  save.addEventListener('click', async () => {
    error.textContent = '';
    const def = defaultSelect.value;
    const out = { default: def, devices: {} };
    try {
      for (const [id, row] of rows) {
        const ranges = {};
        if (row.access === 'control') {
          for (const { cap, min, max } of row.inputs) {
            const r = parseRange({ ...cap, label: labelFor(cap) }, min.value, max.value);
            if (r) ranges[cap.property] = r;
          }
          // Keep ranges of rows that were never rendered with inputs (none today, but be safe).
          if (!row.inputs.length) Object.assign(ranges, row.ranges);
        }
        if (row.access !== def || Object.keys(ranges).length) out.devices[id] = { access: row.access, ...(Object.keys(ranges).length ? { ranges } : {}) };
      }
      if (isAi) Object.assign(out, { canControl: canControl.checked, canConfigure: canConfigure.checked });
    } catch (err) {
      error.textContent = err.message;
      return;
    }
    save.disabled = true;
    try {
      await onSave(out);
      toast('Limits saved');
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
}
