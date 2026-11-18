import { EventEmitter } from 'node:events';
import { HttpError } from '../http/errors.js';

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
    device.state = { ...device.state, ...changes };
    this.emit('state', device, changes, metadata);
  }

  setAvailable(id, available) {
    const device = this.#devices.get(id);
    if (!device || device.available === available) return;
    device.available = available;
    this.emit('device:updated', device);
  }

  /** Send a command to a device through its provider. Throws on invalid input. */
  async command(id, values) {
    const device = this.#devices.get(id);
    if (!device) throw new HttpError(404, `Unknown device ${id}`);
    const provider = this.#providers.get(device.provider);
    if (!provider) throw new HttpError(500, `Provider ${device.provider} not loaded`);
    return provider.command(device, values);
  }
}

// Kept as an alias so providers can keep importing RegistryError.
export { HttpError as RegistryError };
