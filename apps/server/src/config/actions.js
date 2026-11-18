import { EventEmitter } from 'node:events';
import { HttpError } from '../http/errors.js';
import { Validator, ID_RE, slugify } from './validate.js';
import { uniqueId } from './pages.js';

/**
 * Actions are named sequences of steps (a scene, a routine), run by a button,
 * by the AI, or automatically by triggers.
 *
 * {
 *   id: 'movie-night', name: 'Movie night', description: '…', enabled: true,
 *   steps: [
 *     { type: 'set', deviceId: 'z2m:…', values: { state: 'ON', brightness: 40 } },
 *     { type: 'delay', seconds: 2 },
 *     { type: 'run', actionId: 'close-blinds' },
 *   ],
 *   triggers: [
 *     { type: 'state', deviceId: 'z2m:…', property: 'occupancy', op: 'eq', value: true },
 *     { type: 'time', at: '07:30', days: ['mon','tue','wed','thu','fri'] },
 *   ],
 * }
 */
export const STEP_TYPES = ['set', 'delay', 'run'];
export const TRIGGER_TYPES = ['state', 'time'];
export const OPERATORS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed'];
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_DELAY_S = 3600;
const MAX_DEPTH = 5;
const TRIGGER_COOLDOWN_MS = 2000;

export class ActionStore extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
  }

  list() {
    return this.store.read('actions', []).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.list().find((a) => a.id === id) ?? null;
  }

  create(input) {
    const actions = this.store.read('actions', []);
    const action = normalizeAction({ ...input, id: input.id ?? uniqueId(slugify(input.name), actions) });
    if (actions.some((a) => a.id === action.id)) throw new HttpError(409, `Action ${action.id} already exists`);
    actions.push(action);
    this.store.write('actions', actions);
    this.emit('changed');
    return action;
  }

  update(id, changes) {
    const actions = this.store.read('actions', []);
    const index = actions.findIndex((a) => a.id === id);
    if (index === -1) throw new HttpError(404, 'Unknown action');
    const action = normalizeAction({ ...actions[index], ...changes, id });
    actions[index] = action;
    this.store.write('actions', actions);
    this.emit('changed');
    return action;
  }

  delete(id) {
    const actions = this.store.read('actions', []);
    if (!actions.some((a) => a.id === id)) throw new HttpError(404, 'Unknown action');
    this.store.write('actions', actions.filter((a) => a.id !== id));
    this.emit('changed');
  }
}

export function normalizeAction(input) {
  const v = new Validator();
  v.check(ID_RE.test(input.id ?? ''), 'id must be lowercase letters, numbers and dashes');
  v.string(input.name, 'name', { max: 80 });
  v.string(input.description, 'description', { max: 500, optional: true });
  const steps = input.steps ?? [];
  const triggers = input.triggers ?? [];

  if (v.array(steps, 'steps', { max: 50 })) {
    v.check(steps.length > 0, 'steps must contain at least one step');
    steps.forEach((step, i) => {
      const path = `steps[${i}]`;
      if (!v.oneOf(step?.type, STEP_TYPES, `${path}.type`)) return;
      if (step.type === 'set') {
        v.string(step.deviceId, `${path}.deviceId`);
        v.check(step.values && typeof step.values === 'object' && !Array.isArray(step.values) && Object.keys(step.values).length > 0,
          `${path}.values must be an object like { "state": "ON" }`);
      } else if (step.type === 'delay') {
        v.check(typeof step.seconds === 'number' && step.seconds > 0 && step.seconds <= MAX_DELAY_S,
          `${path}.seconds must be between 0 and ${MAX_DELAY_S}`);
      } else {
        v.string(step.actionId, `${path}.actionId`);
        v.check(step.actionId !== input.id, `${path} cannot run its own action`);
      }
    });
  }

  if (v.array(triggers, 'triggers', { max: 20 })) {
    triggers.forEach((trigger, i) => {
      const path = `triggers[${i}]`;
      if (!v.oneOf(trigger?.type, TRIGGER_TYPES, `${path}.type`)) return;
      if (trigger.type === 'state') {
        v.string(trigger.deviceId, `${path}.deviceId`);
        v.string(trigger.property, `${path}.property`, { max: 64 });
        const op = trigger.op ?? 'eq';
        v.oneOf(op, OPERATORS, `${path}.op`);
        if (op !== 'changed') v.check(trigger.value !== undefined, `${path}.value is required for op ${op}`);
        if (['gt', 'lt', 'gte', 'lte'].includes(op)) v.check(typeof trigger.value === 'number', `${path}.value must be a number for op ${op}`);
      } else {
        v.check(/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.at ?? ''), `${path}.at must be HH:MM (24h)`);
        if (trigger.days !== undefined && v.array(trigger.days, `${path}.days`, { max: 7 })) {
          trigger.days.forEach((d) => v.oneOf(d, DAYS, `${path}.days`));
        }
      }
    });
  }
  v.throwIfInvalid();

  return {
    id: input.id,
    name: input.name.trim(),
    description: input.description?.trim() ?? null,
    enabled: input.enabled !== false,
    steps: steps.map((s) =>
      s.type === 'set' ? { type: 'set', deviceId: s.deviceId, values: s.values }
        : s.type === 'delay' ? { type: 'delay', seconds: s.seconds }
          : { type: 'run', actionId: s.actionId }),
    triggers: triggers.map((t) =>
      t.type === 'state'
        ? { type: 'state', deviceId: t.deviceId, property: t.property, op: t.op ?? 'eq', ...(t.value !== undefined ? { value: t.value } : {}) }
        : { type: 'time', at: t.at, ...(t.days ? { days: t.days } : {}) }),
  };
}

/**
 * Runs actions and watches their triggers.
 * Events: 'run' ({ actionId, by, ok, error?, startedAt, finishedAt })
 */
export class ActionEngine extends EventEmitter {
  #lastTriggered = new Map();
  #timer = null;
  #lastMinute = null;

  constructor({ actions, registry, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    super();
    this.actions = actions;
    this.registry = registry;
    this.now = now;
    this.sleep = sleep;
    this.onState = this.onState.bind(this);
  }

  start({ tickMs = 15_000 } = {}) {
    this.registry.on('state', this.onState);
    this.#timer = setInterval(() => this.tick(), tickMs);
    this.#timer.unref?.();
  }

  stop() {
    this.registry.off('state', this.onState);
    clearInterval(this.#timer);
  }

  /**
   * Check every set step (including nested actions) with `check(deviceId, values)`, which throws
   * on a step that is not allowed. Used before someone with limits runs an action.
   */
  preflight(id, check, depth = 0) {
    const action = this.actions.get(id);
    if (!action) throw new HttpError(404, `Unknown action ${id}`);
    if (depth > MAX_DEPTH) throw new HttpError(400, `Action nesting deeper than ${MAX_DEPTH}`);
    for (const step of action.steps) {
      if (step.type === 'set') check(step.deviceId, step.values);
      else if (step.type === 'run') this.preflight(step.actionId, check, depth + 1);
    }
  }

  /** Run an action now. `by` describes who started it, e.g. "user:niklas", "trigger", "ai". */
  async run(id, { by = 'manual', depth = 0 } = {}) {
    const action = this.actions.get(id);
    if (!action) throw new HttpError(404, `Unknown action ${id}`);
    if (depth > MAX_DEPTH) throw new HttpError(400, `Action nesting deeper than ${MAX_DEPTH}`);
    const startedAt = this.now().toISOString();
    try {
      for (const step of action.steps) {
        if (step.type === 'set') await this.registry.command(step.deviceId, step.values);
        else if (step.type === 'delay') await this.sleep(step.seconds * 1000);
        else await this.run(step.actionId, { by: `action:${id}`, depth: depth + 1 });
      }
      const result = { actionId: id, by, ok: true, startedAt, finishedAt: this.now().toISOString() };
      if (depth === 0) this.emit('run', result);
      return result;
    } catch (err) {
      const result = { actionId: id, by, ok: false, error: err.message, startedAt, finishedAt: this.now().toISOString() };
      if (depth === 0) this.emit('run', result);
      if (depth > 0) throw err;
      return result;
    }
  }

  onState(device, changes) {
    for (const action of this.actions.list()) {
      if (!action.enabled) continue;
      const hit = action.triggers.some((t) =>
        t.type === 'state' && t.deviceId === device.id && Object.hasOwn(changes, t.property)
        && compare(changes[t.property], t.op, t.value));
      if (hit) this.#fire(action, 'trigger:state');
    }
  }

  /** Called periodically; fires time triggers once in the minute they match. */
  tick() {
    const now = this.now();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const minuteKey = `${now.toDateString()} ${hhmm}`;
    if (minuteKey === this.#lastMinute) return;
    this.#lastMinute = minuteKey;
    const day = DAYS[now.getDay()];
    for (const action of this.actions.list()) {
      if (!action.enabled) continue;
      const hit = action.triggers.some((t) => t.type === 'time' && t.at === hhmm && (!t.days || t.days.includes(day)));
      if (hit) this.#fire(action, 'trigger:time');
    }
  }

  #fire(action, by) {
    // Cooldown stops an action from re-triggering itself through its own state changes.
    const last = this.#lastTriggered.get(action.id) ?? 0;
    const now = this.now().getTime();
    if (now - last < TRIGGER_COOLDOWN_MS) return;
    this.#lastTriggered.set(action.id, now);
    this.run(action.id, { by }).catch(() => {});
  }
}

export function compare(actual, op, expected) {
  switch (op) {
    case 'changed': return true;
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return typeof actual === 'number' && actual > expected;
    case 'lt': return typeof actual === 'number' && actual < expected;
    case 'gte': return typeof actual === 'number' && actual >= expected;
    case 'lte': return typeof actual === 'number' && actual <= expected;
    default: return false;
  }
}
