import { api } from '../api.js';
import { h, onSubmit, toast } from '../ui.js';
import { labelFor } from '../controls.js';
import { field } from './auth.js';
import { selectField, valueField } from './value-fields.js';

const layouts = [['grid', 'Grid'], ['list', 'List'], ['3d', '3D floor plan']];
const steps = [['set', 'Set a device'], ['delay', 'Wait'], ['run', 'Run another action']];
const triggers = [['time', 'At a time'], ['state', 'When a device reports a value']];
const operators = [['eq', 'Equals'], ['ne', 'Does not equal'], ['gt', 'Above'], ['gte', 'At least'], ['lt', 'Below'], ['lte', 'At most'], ['changed', 'Any update']];
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const pageCollection = { title: 'Pages', item: 'page', name: 'title', load: api.pages, save: api.savePage, remove: api.deletePage };
const actionCollection = { title: 'Actions', item: 'action', name: 'name', load: api.actions, save: api.saveAction, remove: api.deleteAction };

/** Edit the same pages and actions used by the dashboard and the AI tools. */
export async function openConfigDialog(kind) {
  const collection = kind === 'pages' ? pageCollection : actionCollection;
  const body = h('div.ai-block');
  const dialog = h('dialog.panel.wide', { 'aria-labelledby': 'config-title' },
    h('header', {}, h('h2', { id: 'config-title' }, collection.title),
      button('✕', () => dialog.close(), { 'aria-label': 'Close' })),
    body,
  );
  dialog.addEventListener('close', () => dialog.remove());
  await list();
  document.body.append(dialog);
  dialog.showModal();

  async function list() {
    const items = await collection.load();
    const start = kind === 'pages' && items.find((item) => item.startPage);
    async function updateList(save) {
      try {
        await save();
        await list();
      } catch (err) {
        showError(err);
      }
    }
    const move = (index, direction) => updateList(() => {
      const ids = items.map((item) => item.id);
      ids.splice(index + direction, 0, ids.splice(index, 1)[0]);
      return api.reorderPages(ids);
    });
    body.replaceChildren(
      h('div.row', {},
        button(`New ${collection.item}`, () => edit().catch(showError), { className: 'primary' }),
        start ? button('Start on All devices', () => updateList(() => api.setPageStart(start.id, false))) : null,
      ),
      ...items.map((item, index) => h('div.row.config-entry', {},
        h('strong', {}, item[collection.name], item.startPage ? h('small.muted', {}, ' · Start page') : null),
        h('div.row', {},
          kind === 'pages' ? [
            button('↑', () => move(index, -1), { 'aria-label': `Move ${item.title} up`, disabled: index === 0 }),
            button('↓', () => move(index, 1), { 'aria-label': `Move ${item.title} down`, disabled: index === items.length - 1 }),
            item.startPage ? null : button('Set as start page', () => updateList(() => api.setPageStart(item.id, true)),
              { 'aria-label': `Set ${item.title} as start page` }),
          ] : null,
          button('Edit', () => edit(item).catch(showError), { 'aria-label': `Edit ${item[collection.name]}` }),
        ),
      )),
    );
  }

  async function edit(item) {
    const [devices, actions] = await Promise.all([api.devices(), api.actions()]);
    devices.sort((a, b) => a.name.localeCompare(b.name));
    const caps = (id) => devices.find((device) => device.id === id)?.capabilities ?? [];
    const draft = structuredClone(item ?? (kind === 'pages'
      ? { title: '', layout: 'grid', sections: [] }
      : { name: '', enabled: true, steps: [{ type: 'set', deviceId: '', values: {} }], triggers: [] }));
    const editor = h('div.settings-fields');
    const form = h('form.settings-fields', {}, editor, h('p.form-error', { role: 'alert' }),
      h('div.row', {},
        h('button.primary', { type: 'submit' }, `Save ${collection.item}`),
        button('Cancel', () => list().catch(showError)),
        item ? button('Delete', async () => {
          if (!window.confirm(`Delete “${item[collection.name]}”?`)) return;
          try {
            await collection.remove(item.id);
            await list();
          } catch (err) {
            showError(err);
          }
        }) : null,
      ));
    onSubmit(form, async () => {
      await collection.save(draft);
      await list();
    });
    if (!dialog.open) return;
    body.replaceChildren(form);
    draw();

    function draw() {
      const name = textField(kind === 'pages' ? 'Title' : 'Name', draft, collection.name, 80, true);
      editor.replaceChildren(name, ...(kind === 'pages' ? pageFields() : actionFields()));
    }

    function pageFields() {
      return [
        selectField('Layout', layouts, draft.layout, (value) => { draft.layout = value; }),
        h('div.row', {},
          textField('Icon (optional)', draft, 'icon', 16),
          h('label.row', {}, h('input', { type: 'checkbox', checked: draft.startPage,
            onchange: (e) => { draft.startPage = e.target.checked; } }), 'Open on startup'),
        ),
        ...draft.sections.map((section, index) => h('fieldset.config-group.settings-fields', {},
          h('legend', {}, `Section ${index + 1}`),
          textField('Section title (optional)', section, 'title', 80),
          ...section.items.map((entry, i) => h('div.config-group.settings-fields', {},
            entry.type === 'device'
              ? deviceField(entry.deviceId, (value) => {
                entry.deviceId = value;
                delete entry.properties;
                draw();
              })
              : actionField(entry.actionId, (value) => { entry.actionId = value; }),
            entry.type === 'device' ? propertyFilter(entry) : null,
            rowButtons(section.items, i, 'item'),
          )),
          h('div.row', {},
            button('Add device', () => add(section.items, { type: 'device', deviceId: '' })),
            button('Add action', () => add(section.items, { type: 'action', actionId: '' })),
          ),
          rowButtons(draft.sections, index, 'section'),
        )),
        button('Add section', () => add(draft.sections, { title: null, items: [] })),
      ];
    }

    function propertyFilter(entry) {
      const device = devices.find((d) => d.id === entry.deviceId);
      if (!device?.capabilities.length) return null;
      const select = h('select', { multiple: true, size: Math.min(5, device.capabilities.length) });
      const options = new Map(device.capabilities.map((cap) => [cap.property, labelFor(cap)]));
      for (const name of entry.properties ?? []) if (!options.has(name)) options.set(name, name);
      for (const [value, label] of options) select.append(new Option(label, value, false, entry.properties?.includes(value)));
      select.addEventListener('change', () => {
        const selected = [...select.selectedOptions].map((option) => option.value);
        if (selected.length) entry.properties = selected;
        else delete entry.properties;
      });
      return h('details', {}, h('summary', {}, 'Shown controls'), field('Select controls, or leave empty to show all', select));
    }

    function actionFields() {
      return [
        textField('Description (optional)', draft, 'description', 500),
        h('label.row', {}, h('input', { type: 'checkbox', checked: draft.enabled,
          onchange: (e) => { draft.enabled = e.target.checked; } }), 'Enabled'),
        h('h3', {}, 'Steps'),
        ...draft.steps.map((step, i) => h('fieldset.config-group.settings-fields', {},
          h('legend', {}, `Step ${i + 1}`),
          selectField('Type', steps, step.type, (type) => {
            draft.steps[i] = { type, ...(type === 'set' ? { deviceId: '', values: {} } : {}) };
            draw();
          }),
          step.type === 'set' ? setFields(step)
            : step.type === 'delay' ? field('Seconds', h('input', { type: 'number', min: '0.001', max: '3600', step: 'any',
              required: true, value: step.seconds ?? '', oninput: (e) => { step.seconds = e.target.valueAsNumber; } }))
              : actionField(step.actionId, (value) => { step.actionId = value; }),
          rowButtons(draft.steps, i, 'step'),
        )),
        button('Add step', () => add(draft.steps, { type: 'set', deviceId: '', values: {} })),
        h('h3', {}, 'Automatic triggers'),
        ...draft.triggers.map((trigger, i) => h('fieldset.config-group.settings-fields', {},
          h('legend', {}, `Trigger ${i + 1}`),
          selectField('Type', triggers, trigger.type, (type) => {
            draft.triggers[i] = type === 'state' ? { type, op: 'eq' } : { type, at: '' };
            draw();
          }),
          trigger.type === 'time' ? timeFields(trigger) : stateFields(trigger),
          rowButtons(draft.triggers, i, 'trigger'),
        )),
        button('Add trigger', () => add(draft.triggers, { type: 'time', at: '' })),
      ];
    }

    function setFields(step) {
      const capabilities = caps(step.deviceId).filter((cap) => cap.writable);
      const available = capabilities.filter((cap) => !Object.hasOwn(step.values, cap.property));
      return [
        deviceField(step.deviceId, (deviceId) => {
          Object.assign(step, { deviceId, values: {} });
          draw();
        }),
        ...Object.entries(step.values).map(([property, value]) => h('div.settings-fields', {},
          valueField(capabilities.find((cap) => cap.property === property), property, value, (next) => {
            step.values[property] = next;
          }),
          button(`Remove ${property}`, () => { delete step.values[property]; draw(); }),
        )),
        selectField('Add a setting', available.map((cap) => [cap.property, labelFor(cap)]), '', (property) => {
          if (!property) return;
          const cap = available.find((option) => option.property === property);
          step.values[property] = cap.valueOn ?? cap.values?.[0] ?? cap.min ?? (cap.type === 'numeric' ? 0 : '');
          draw();
        }, { placeholder: 'Choose a writable control', required: Object.keys(step.values).length === 0, disabled: !available.length }),
      ];
    }

    function timeFields(trigger) {
      return [
        field('Time (server time zone)', h('input', { type: 'time', required: true, value: trigger.at,
          oninput: (e) => { trigger.at = e.target.value; } })),
        selectField('Days', [['every', 'Every day'], ['selected', 'Selected days']], trigger.days ? 'selected' : 'every', (value) => {
          if (value === 'every') delete trigger.days;
          else trigger.days = [...weekdays.slice(0, 5)];
          draw();
        }),
        trigger.days ? h('div.row', {}, weekdays.map((day) => h('label.row', {},
          h('input', { type: 'checkbox', checked: trigger.days.includes(day), onchange: (e) => {
            trigger.days = e.target.checked ? [...trigger.days, day] : trigger.days.filter((d) => d !== day);
          } }), day,
        ))) : null,
      ];
    }

    function stateFields(trigger) {
      const capabilities = caps(trigger.deviceId).filter((cap) => cap.readable);
      const cap = capabilities.find((item) => item.property === trigger.property);
      const numeric = ['gt', 'gte', 'lt', 'lte'].includes(trigger.op);
      return [
        deviceField(trigger.deviceId, (deviceId) => {
          Object.assign(trigger, { deviceId, property: '', value: undefined });
          draw();
        }),
        selectField('Device property', capabilities.map((item) => [item.property, labelFor(item)]), trigger.property, (property) => {
          Object.assign(trigger, { property, value: undefined });
          draw();
        }, { placeholder: 'Choose a property', required: true }),
        selectField('Condition', operators, trigger.op, (op) => {
          trigger.op = op;
          if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof trigger.value !== 'number') delete trigger.value;
          draw();
        }),
        trigger.op === 'changed' ? null : valueField(numeric ? { type: 'numeric' } : cap, 'Value', trigger.value, (value) => {
          trigger.value = value;
        }, 'Value'),
      ];
    }

    function add(items, item) {
      items.push(item);
      draw();
    }

    function rowButtons(items, index, noun) {
      const move = (offset) => {
        const [item] = items.splice(index, 1);
        items.splice(index + offset, 0, item);
        draw();
      };
      return h('div.row', {},
        button('Move up', () => move(-1), { disabled: index === 0 }),
        button('Move down', () => move(1), { disabled: index === items.length - 1 }),
        button(`Remove ${noun}`, () => { items.splice(index, 1); draw(); }),
      );
    }

    function deviceField(id, update) {
      return selectField('Device', devices.map((d) => [d.id, d.name]), id, update, { placeholder: 'Choose a device', required: true });
    }
    function actionField(id, update) {
      return selectField('Action', actions.filter((a) => a.id !== draft.id).map((a) => [a.id, a.name]), id, update, { placeholder: 'Choose an action', required: true });
    }
  }
}

function showError(err) {
  toast(err.message);
}

function button(label, onclick, props = {}) {
  return h('button', { type: 'button', onclick, ...props }, label);
}

function textField(label, draft, key, maxLength, required = false) {
  return field(label, h('input', { value: draft[key] ?? '', maxLength, required,
    oninput: (e) => { draft[key] = e.target.value || (required ? '' : null); } }));
}
