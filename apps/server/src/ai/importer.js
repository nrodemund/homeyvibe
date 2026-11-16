import { HttpError } from '../http/errors.js';
import { normalizePage } from '../config/pages.js';
import { normalizeAction } from '../config/actions.js';
import { slugify } from '../config/validate.js';
import { validateValue } from '../providers/zigbee2mqtt/capabilities.js';

/**
 * Apply a `{ pages, actions }` bundle (typically written by an LLM from the context file).
 * Everything is validated first; nothing is written unless all of it is valid.
 * Items with an existing id are updated, new ones are created.
 *
 * @returns {{ created: { pages: string[], actions: string[] }, updated: { pages: string[], actions: string[] } }}
 */
export function importConfig({ bundle, pages, actions, registry }) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new HttpError(400, 'Expected an object like { "pages": [...], "actions": [...] }');
  }
  const pageList = bundle.pages ?? [];
  const actionList = bundle.actions ?? [];
  if (!Array.isArray(pageList) || !Array.isArray(actionList)) throw new HttpError(400, 'pages and actions must be arrays');
  if (!pageList.length && !actionList.length) throw new HttpError(400, 'Nothing to import');

  const errors = [];
  const withIds = (list, nameKey) => list.map((item) => ({ ...item, id: item?.id ?? slugify(item?.[nameKey]) }));
  const normalizedActions = [];
  for (const [i, raw] of withIds(actionList, 'name').entries()) {
    try {
      normalizedActions.push(normalizeAction(raw));
    } catch (err) {
      errors.push(`actions[${i}]: ${err.message}`);
    }
  }
  const normalizedPages = [];
  for (const [i, raw] of withIds(pageList, 'title').entries()) {
    try {
      normalizedPages.push(normalizePage(raw));
    } catch (err) {
      errors.push(`pages[${i}]: ${err.message}`);
    }
  }

  // Cross-references: devices, capabilities and actions must exist.
  const actionIds = new Set([...actions.list().map((a) => a.id), ...normalizedActions.map((a) => a.id)]);
  const checkDevice = (path, deviceId, properties = [], values = null) => {
    const device = registry.get(deviceId);
    if (!device) return errors.push(`${path}: unknown device ${deviceId}`);
    for (const p of properties) {
      const cap = device.capabilities.find((c) => c.property === p);
      if (!cap) errors.push(`${path}: ${deviceId} has no capability ${p}`);
      else if (values) {
        const problem = validateValue(cap, values[p]);
        if (problem) errors.push(`${path}: ${problem}`);
      }
    }
  };
  normalizedActions.forEach((a, i) => {
    a.steps.forEach((s, j) => {
      if (s.type === 'set') checkDevice(`actions[${i}].steps[${j}]`, s.deviceId, Object.keys(s.values), s.values);
      if (s.type === 'run' && !actionIds.has(s.actionId)) errors.push(`actions[${i}].steps[${j}]: unknown action ${s.actionId}`);
    });
    a.triggers.forEach((t, j) => {
      if (t.type === 'state') checkDevice(`actions[${i}].triggers[${j}]`, t.deviceId, [t.property]);
    });
  });
  normalizedPages.forEach((p, i) => {
    p.sections.forEach((s, j) => s.items.forEach((item, k) => {
      const path = `pages[${i}].sections[${j}].items[${k}]`;
      if (item.type === 'device') checkDevice(path, item.deviceId, item.properties ?? []);
      else if (!actionIds.has(item.actionId)) errors.push(`${path}: unknown action ${item.actionId}`);
    }));
  });
  if (errors.length) throw new HttpError(400, errors.join('; '));

  const result = { created: { pages: [], actions: [] }, updated: { pages: [], actions: [] } };
  for (const a of normalizedActions) {
    if (actions.get(a.id)) {
      actions.update(a.id, a);
      result.updated.actions.push(a.id);
    } else {
      actions.create(a);
      result.created.actions.push(a.id);
    }
  }
  for (const p of normalizedPages) {
    const { order, ...rest } = p;
    if (pages.get(p.id)) {
      pages.update(p.id, order === undefined ? rest : p);
      result.updated.pages.push(p.id);
    } else {
      pages.create(order === undefined ? rest : p);
      result.created.pages.push(p.id);
    }
  }
  return result;
}
