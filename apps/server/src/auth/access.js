import { EventEmitter } from 'node:events';
import { HttpError } from '../http/errors.js';
import { PERMISSIONS, permissionsFor } from './roles.js';

/**
 * Who may see and control which device, and within which values.
 *
 * Limits (for the AI, or for a person who is not an admin):
 *   {
 *     default: 'control' | 'view' | 'hidden',          // devices not listed, including new ones
 *     devices: { [deviceId]: { access: 'control' | 'view' | 'hidden', ranges?: { [property]: [min, max] } } },
 *   }
 *
 * The AI has its own settings on top of that: whether it may control devices at all and whether it may
 * change the setup (pages, actions, floor plan). When the AI acts for a person (in-app chat or MCP),
 * it gets what both of them are allowed: the person's role and limits, and the AI's.
 */
export const ACCESS_LEVELS = ['control', 'view', 'hidden'];
const RANK = { hidden: 0, view: 1, control: 2 };

export const AI_USER = Object.freeze({ id: 'ai', username: 'ai', displayName: 'HomeyVibe AI' });

const OPEN = { default: 'control', devices: {} };
const DEFAULT_AI = { canControl: true, canConfigure: true, ...OPEN };

export class AccessStore extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
  }

  #read() {
    return this.store.read('access', { ai: DEFAULT_AI, users: {} });
  }

  all() {
    const data = this.#read();
    return { ai: { ...DEFAULT_AI, ...data.ai }, users: data.users ?? {} };
  }

  ai() {
    return this.all().ai;
  }

  userLimits(userId) {
    return this.all().users[userId] ?? OPEN;
  }

  setAi(input) {
    const data = this.all();
    data.ai = {
      canControl: bool(input.canControl, 'canControl', data.ai.canControl),
      canConfigure: bool(input.canConfigure, 'canConfigure', data.ai.canConfigure),
      ...normalizeLimits(input),
    };
    this.store.write('access', data);
    this.emit('changed');
    return data.ai;
  }

  setUser(userId, input) {
    const data = this.all();
    const limits = normalizeLimits(input);
    if (isOpen(limits)) delete data.users[userId];
    else data.users[userId] = limits;
    this.store.write('access', data);
    this.emit('changed');
    return limits;
  }

  removeUser(userId) {
    const data = this.all();
    if (!data.users[userId]) return;
    delete data.users[userId];
    this.store.write('access', data);
    this.emit('changed');
  }

  /** Policy for a signed-in person. Admins are never limited. */
  policyFor(user) {
    if (!user || user.role === 'admin') return new Policy([]);
    return new Policy([this.userLimits(user.id)]);
  }

  /** Policy and effective permissions when the AI acts for `user`. */
  aiFor(user) {
    const ai = this.ai();
    const allowed = new Set([PERMISSIONS.DEVICES_READ]);
    if (ai.canControl) allowed.add(PERMISSIONS.DEVICES_CONTROL);
    if (ai.canConfigure) allowed.add(PERMISSIONS.CONFIG_WRITE);
    const permissions = (user.permissions ?? permissionsFor(user.role)).filter((p) => allowed.has(p));
    const layers = [ai];
    if (user.role !== 'admin') layers.push(this.userLimits(user.id));
    return { user: { ...user, permissions }, policy: new Policy(layers), ai };
  }
}

/** Combined limits: a device gets the lowest access of all layers, and ranges narrow to their overlap. */
export class Policy {
  constructor(layers) {
    this.layers = layers;
  }

  get unrestricted() {
    return this.layers.every(isOpen);
  }

  access(deviceId) {
    let level = 'control';
    for (const layer of this.layers) {
      const a = layer.devices?.[deviceId]?.access ?? layer.default ?? 'control';
      if (RANK[a] < RANK[level]) level = a;
    }
    return level;
  }

  canSee(deviceId) {
    return this.access(deviceId) !== 'hidden';
  }

  /** { property: [min, max] } that applies to this device. */
  ranges(deviceId) {
    const out = {};
    for (const layer of this.layers) {
      for (const [prop, [min, max]] of Object.entries(layer.devices?.[deviceId]?.ranges ?? {})) {
        const [a, b] = out[prop] ?? [-Infinity, Infinity];
        out[prop] = [Math.max(a, min), Math.min(b, max)];
      }
    }
    return out;
  }

  /** Throws a 403 explaining the problem when `values` are not allowed on the device. */
  check(device, values) {
    const access = this.access(device.id);
    if (access === 'hidden') throw new HttpError(404, 'Unknown device');
    if (access === 'view') throw new HttpError(403, `${device.name} is view only for you`);
    const ranges = this.ranges(device.id);
    const problems = [];
    for (const [prop, value] of Object.entries(values ?? {})) {
      const range = ranges[prop];
      if (!range) continue;
      const [min, max] = range;
      if (typeof value !== 'number' || value < min || value > max) {
        const cap = device.capabilities?.find((c) => c.property === prop);
        const label = cap?.name && /[A-Z ]/.test(cap.name) ? cap.name.toLowerCase() : prop;
        const unit = cap?.unit ? ` ${cap.unit}` : '';
        problems.push(`${device.name}: ${label} must be between ${min} and ${max}${unit}`);
      }
    }
    if (problems.length) throw new HttpError(403, `Outside the allowed range. ${problems.join('; ')}`);
  }

  /** A device as this policy shows it: null when hidden, otherwise with `access` and `ranges` added. */
  decorate(device) {
    if (this.unrestricted) return device;
    const access = this.access(device.id);
    if (access === 'hidden') return null;
    const ranges = this.ranges(device.id);
    return { ...device, access, ...(Object.keys(ranges).length ? { ranges } : {}) };
  }
}

/**
 * The registry as a policy sees it: hidden devices do not exist and commands are checked first.
 * Used for everything an AI does, and for device routes of limited people.
 */
export function scopedRegistry(registry, policy) {
  return {
    policy,
    list: () => registry.list().map((d) => policy.decorate(d)).filter(Boolean),
    get: (id) => {
      const device = registry.get(id);
      return device ? policy.decorate(device) : undefined;
    },
    async command(id, values, timer) {
      const device = registry.get(id);
      if (!device || !policy.canSee(id)) throw new HttpError(404, 'Unknown device');
      policy.check(device, values);
      if (timer) policy.check(device, timer.values);
      return registry.command(id, values, timer);
    },
    /** Throws when `values` are not allowed (or the device is hidden), without sending anything. */
    check(id, values) {
      const device = registry.get(id);
      if (!device || !policy.canSee(id)) throw new HttpError(404, `Unknown device ${id}`);
      policy.check(device, values);
    },
  };
}

// ---- validation ----------------------------------------------------------------------------

export function normalizeLimits(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected { default, devices }');
  const errors = [];
  const level = (v, path) => {
    if (!ACCESS_LEVELS.includes(v)) errors.push(`${path} must be one of ${ACCESS_LEVELS.join(', ')}`);
    return v;
  };
  const def = level(input.default ?? 'control', 'default');
  const devices = {};
  const raw = input.devices ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) errors.push('devices must be an object keyed by device id');
  else {
    for (const [id, entry] of Object.entries(raw).slice(0, 1000)) {
      const path = `devices.${id}`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${path} must be an object`);
        continue;
      }
      const access = level(entry.access ?? def, `${path}.access`);
      const ranges = {};
      for (const [prop, range] of Object.entries(entry.ranges ?? {})) {
        const ok = Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === 'number' && Number.isFinite(n)) && range[0] <= range[1];
        if (!ok) errors.push(`${path}.ranges.${prop} must be [min, max] with min <= max`);
        else ranges[prop] = range;
      }
      // Only keep entries that differ from the default.
      if (access !== def || Object.keys(ranges).length) devices[id] = { access, ...(Object.keys(ranges).length ? { ranges } : {}) };
    }
  }
  if (errors.length) throw new HttpError(400, errors.join('; '));
  return { default: def, devices };
}

function isOpen(limits) {
  return (limits.default ?? 'control') === 'control'
    && Object.values(limits.devices ?? {}).every((d) => d.access === 'control' && !Object.keys(d.ranges ?? {}).length);
}

function bool(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false`);
  return value;
}
