import { HttpError } from '../http/errors.js';
import { normalizePage } from '../config/pages.js';
import { normalizeAction } from '../config/actions.js';
import { normalizeFloorplan } from '../config/floorplan.js';
import { checkPlacementSettings } from '../config/floorplan-settings.js';
import { slugify } from '../config/validate.js';
import { validateValue } from '../providers/zigbee2mqtt/capabilities.js';

/**
 * Apply a `{ pages, actions, floorplan? }` bundle (typically written by an LLM from the context file).
 * Everything is validated first; nothing is written unless all of it is valid.
 * Items with an existing id are updated, new ones are created. A floorplan replaces the current one.
 *
 * @returns {{ created: { pages: string[], actions: string[] }, updated: { pages: string[], actions: string[] }, floorplan?: { rooms: number, devices: number } }}
 */
export function importConfig({ bundle, pages, actions, registry, floorplan = null, canControl = true }) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new HttpError(400, 'Expected an object like { "pages": [...], "actions": [...] }');
  }
  const pageList = bundle.pages ?? [];
  const actionList = bundle.actions ?? [];
  if (!Array.isArray(pageList) || !Array.isArray(actionList)) throw new HttpError(400, 'pages and actions must be arrays');
  const planInput = bundle.floorplan;
  if (planInput !== undefined && !floorplan) throw new HttpError(400, 'This server does not store a floor plan');
  if (!pageList.length && !actionList.length && planInput === undefined) throw new HttpError(400, 'Nothing to import');

  const errors = [];
  let plan = null;
  if (planInput !== undefined) {
    try {
      plan = normalizeFloorplan(planInput);
      plan.devices.forEach((d, i) => {
        if (!registry.get(d.deviceId)) errors.push(`floorplan.devices[${i}]: unknown device ${d.deviceId}`);
      });
    } catch (err) {
      errors.push(`floorplan: ${err.message}`);
    }
  }
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
  const actionsById = new Map([...actions.list(), ...normalizedActions].map((a) => [a.id, a]));
  if (normalizedPages.filter((page) => page.startPage).length > 1) errors.push('Only one page can be the start page');
  if (plan) {
    const previous = floorplan.get();
    const old = new Map(previous.devices.map((entry) => [entry.deviceId, entry]));
    for (const entry of plan.devices) {
      const click = old.get(entry.deviceId)?.click;
      if (!entry.click && ['command', 'action'].includes(click?.mode) &&
        (!canControl || registry.get(entry.deviceId)?.access === 'view')) entry.click = click;
    }
    errors.push(...checkPlacementSettings(plan, previous, { registry, lookupAction: (id) => actionsById.get(id), canControl }));
  }
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
      if (s.type === 'set') {
        const path = `actions[${i}].steps[${j}]`;
        const before = errors.length;
        checkDevice(path, s.deviceId, Object.keys(s.values), s.values);
        // A limited importer (the AI) may not write actions that go beyond its own limits.
        if (registry.check && errors.length === before) {
          try {
            registry.check(s.deviceId, s.values);
          } catch (err) {
            errors.push(`${path}: ${err.message}`);
          }
        }
      }
      if (s.type === 'run' && !actionsById.has(s.actionId)) errors.push(`actions[${i}].steps[${j}]: unknown action ${s.actionId}`);
    });
    a.triggers.forEach((t, j) => {
      if (t.type === 'state') checkDevice(`actions[${i}].triggers[${j}]`, t.deviceId, [t.property]);
    });
  });
  normalizedPages.forEach((p, i) => {
    p.sections.forEach((s, j) => s.items.forEach((item, k) => {
      const path = `pages[${i}].sections[${j}].items[${k}]`;
      if (item.type === 'device') checkDevice(path, item.deviceId, item.properties ?? []);
      else if (!actionsById.has(item.actionId)) errors.push(`${path}: unknown action ${item.actionId}`);
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
  if (plan) {
    // Placements of devices the importer cannot see are kept as they are.
    const roomIds = new Set(plan.rooms.map((r) => r.id));
    for (const d of floorplan.get().devices) {
      if (registry.policy && !registry.policy.canSee(d.deviceId) && !plan.devices.some((p) => p.deviceId === d.deviceId)) {
        plan.devices.push({ ...d, roomId: roomIds.has(d.roomId) ? d.roomId : null });
      }
    }
    floorplan.replace(plan);
    result.floorplan = { rooms: plan.rooms.length, devices: plan.devices.length };
  }
  return result;
}
