import { EventEmitter } from 'node:events';
import { HttpError } from '../http/errors.js';
import { DeviceHistory } from './history.js';

/**
 * In-memory registry of every device known to any provider.
 *
 * Device shape:
 * { id, provider, name, model, vendor, description, capabilities: [], state: {}, available }
 *
 * Events: 'device:added', 'device:updated', 'device:removed', 'state' (device, changes)
 */
export class DeviceRegistry extends EventEmitter {
  #devices = new Map();
  #providers = new Map();
  constructor({ history = new DeviceHistory() } = {}) {
    super();
    this.deviceHistory = history;
  }

  registerProvider(provider) {
    this.#providers.set(provider.id, provider);
  }

  list() {
    return [...this.#devices.values()];
  }

  get(id) {
    return this.#devices.get(id);
  }

  upsert(device) {
    const existing = this.#devices.get(device.id);
    const merged = existing
      ? { ...existing, ...device, state: existing.state }
      : { state: {}, available: true, ...device };
    this.#devices.set(device.id, merged);
    if (!existing) this.recordHistory(() => this.deviceHistory.record(merged, merged.state, {}, { retained: true }));
    this.emit(existing ? 'device:updated' : 'device:added', merged);
    return merged;
  }

  remove(id) {
    const device = this.#devices.get(id);
    if (!device) return;
    this.#devices.delete(id);
    this.emit('device:removed', device);
  }

  /** Remove all devices of a provider that are not in keepIds. */
  prune(providerId, keepIds) {
    for (const device of this.list()) {
      if (device.provider === providerId && !keepIds.has(device.id)) this.remove(device.id);
    }
  }

  updateState(id, changes, metadata) {
    const device = this.#devices.get(id);
    if (!device) return;
    const previous = device.state;
    device.state = { ...previous, ...changes };
    this.recordHistory(() => this.deviceHistory.record(device, changes, previous, {
      ...metadata, onActivity: (event) => this.emit('activity', device, event),
    }));
    this.emit('state', device, changes, metadata);
  }

  history(id, property, range) {
    return this.deviceHistory.get(id, property, range);
  }

  recordHistory(write) {
    try { write(); } catch (err) { console.error('Could not record device history:', err.message); }
  }

  setAvailable(id, available) {
    const device = this.#devices.get(id);
    if (!device || device.available === available) return;
    device.available = available;
    this.emit('device:updated', device);
  }

  /** Send a command to a device through its provider. Throws on invalid input. */
  async command(id, values, timer) {
    if (this.timers) return this.timers.command(id, values, timer);
    if (timer) throw new HttpError(503, 'Device timers are unavailable');
    return this.sendCommand(id, values);
  }

  async sendCommand(id, values) {
    const device = this.#devices.get(id);
    if (!device) throw new HttpError(404, `Unknown device ${id}`);
    const provider = this.#providers.get(device.provider);
    if (!provider) throw new HttpError(500, `Provider ${device.provider} not loaded`);
    const result = await provider.command(device, values);
    this.recordHistory(() => {
      this.deviceHistory.event(id, 'command', null, values);
      this.emit('activity', device, { kind: 'command', property: null });
    });
    return result;
  }
}

// Kept as an alias so providers can keep importing RegistryError.
export { HttpError as RegistryError };
