import { HttpError } from '../http/errors.js';
import { validateValue } from '../providers/zigbee2mqtt/capabilities.js';

export const MAX_TIMER_SECONDS = 7 * 24 * 60 * 60;

export function validateTimerInput(timer, path, validator) {
  validator.check(timer && Number.isInteger(timer.seconds) && timer.seconds >= 1 && timer.seconds <= MAX_TIMER_SECONDS,
    `${path}.timer.seconds must be between 1 and 604800`);
  validator.check(timer?.values && typeof timer.values === 'object' && !Array.isArray(timer.values) && Object.keys(timer.values).length > 0,
    `${path}.timer.values must contain the shutdown settings`);
}

/** Validate shutdown settings before sending an activation. */
export function checkTimer(device, timer) {
  if (!timer || !Number.isInteger(timer.seconds) || timer.seconds < 1 || timer.seconds > MAX_TIMER_SECONDS) {
    throw new HttpError(400, 'Choose a timer between 1 second and 7 days');
  }
  const values = timer.values;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
    throw new HttpError(400, 'Choose what the timer should turn off');
  }
  const errors = Object.entries(values).map(([property, value]) => {
    const cap = device.capabilities.find((item) => item.property === property);
    return cap ? validateValue(cap, value) : `Unknown capability ${property}`;
  }).filter(Boolean);
  if (errors.length) throw new HttpError(400, errors.join('; '));
}

/** Keep one persisted shutoff per device and serialize commands, timer edits and expiry. */
export class DeviceTimers {
  #queues = new Map();
  #pending = new Map();
  #timeout;

  constructor({ store, registry, now = Date.now, retryMs = 15_000 }) {
    this.store = store;
    this.registry = registry;
    this.now = now;
    this.retryMs = retryMs;
    for (const entry of store.read('device-timers', [])) this.#pending.set(entry.deviceId, entry);
    this.#schedule();
  }

  get(id) { return this.#pending.get(id) ?? null; }
  list() { return [...this.#pending.values()]; }

  #serialize(id, task) {
    const promise = (this.#queues.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    this.#queues.set(id, promise);
    const clear = () => { if (this.#queues.get(id) === promise) this.#queues.delete(id); };
    promise.then(clear, clear);
    return promise;
  }

  #set(id, entry) {
    const next = [...this.#pending.values()].filter((timer) => timer.deviceId !== id);
    if (entry) next.push(entry);
    this.store.write('device-timers', next);
    if (entry) this.#pending.set(id, entry);
    else this.#pending.delete(id);
    this.registry.emit('timer', id, entry);
    this.#schedule();
  }

  #schedule() {
    clearTimeout(this.#timeout);
    const next = Math.min(...this.list().map((entry) => entry.retryAt ?? entry.expiresAt));
    if (!Number.isFinite(next)) return;
    this.#timeout = setTimeout(() => this.tick().catch((err) => console.error('Timer error:', err.message)),
      Math.max(10, next - this.now())).unref();
  }

  async tick() {
    const due = this.list().filter((entry) => (entry.retryAt ?? entry.expiresAt) <= this.now());
    await Promise.all(due.map((entry) => this.#serialize(entry.deviceId, async () => {
      const id = entry.deviceId;
      if (this.get(id) !== entry) return;
      try {
        if (this.registry.get(id)?.available === false) throw new Error('Device is offline');
        await this.registry.sendCommand(id, entry.values);
      } catch {
        this.#set(id, { ...entry, retryAt: this.now() + this.retryMs });
        return;
      }
      this.#set(id, null);
    })));
    this.#schedule();
  }

  command(id, values, timer) {
    return this.#serialize(id, async () => {
      const previous = this.get(id);
      if (timer) {
        checkTimer(this.registry.get(id) ?? { capabilities: [] }, timer);
        this.#set(id, { deviceId: id, expiresAt: this.now() + timer.seconds * 1000, values: timer.values });
      }
      try {
        const result = await this.registry.sendCommand(id, values);
        if (!timer && previous && Object.entries(previous.values).every(([key, value]) =>
          Object.hasOwn(values, key) && JSON.stringify(values[key]) === JSON.stringify(value))) this.#set(id, null);
        return result;
      } catch (err) {
        if (timer) this.#set(id, previous);
        throw err;
      }
    });
  }

  update(device, seconds, check) {
    return this.#serialize(device.id, () => {
      const previous = this.get(device.id);
      if (!previous) throw new HttpError(404, 'No active timer');
      check(previous.values);
      if (seconds === null) { this.#set(device.id, null); return null; }
      checkTimer(device, { seconds, values: previous.values });
      const updated = { deviceId: device.id, values: previous.values, expiresAt: this.now() + seconds * 1000 };
      this.#set(device.id, updated);
      return updated;
    });
  }

  close() { clearTimeout(this.#timeout); }
}
