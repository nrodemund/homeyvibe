/** Maintain the union of manually tracked readings and configured floor-plan charts. */
export class HistorySelection {
  constructor({ store, floorplan, registry }) {
    this.store = store;
    this.floorplan = floorplan;
    this.registry = registry;
    this.sync();
    floorplan.on('changed', () => this.sync());
    registry.on('device:added', () => this.sync());
  }

  sync() {
    this.manual = this.store.read('history-settings', {});
    const tracked = new Map(Object.entries(this.manual).map(([id, properties]) => [id, new Set(properties)]));
    for (const entry of this.floorplan.get().devices) {
      if (entry.hidden) continue;
      const device = this.registry.get(entry.deviceId);
      const numeric = device?.capabilities.filter((cap) => cap.readable && cap.type === 'numeric')
        .sort((a, b) => Number(a.category === 'diagnostic') - Number(b.category === 'diagnostic'));
      const fields = [entry.display, entry.click].filter((setting) => ['chart', 'trend'].includes(setting?.mode));
      for (const field of fields) {
        const property = field.property ?? numeric?.[0]?.property;
        if (!property) continue;
        if (!tracked.has(entry.deviceId)) tracked.set(entry.deviceId, new Set());
        tracked.get(entry.deviceId).add(property);
      }
    }
    this.registry.deviceHistory.setTracked(tracked);
  }

  get(device, property) {
    return {
      persistent: !!this.registry.deviceHistory.db && this.registry.deviceHistory.tracked(device, property),
      manual: this.manual[device]?.includes(property) ?? false,
    };
  }

  update(device, property, enabled) {
    const values = new Set(this.manual[device] ?? []);
    if (enabled) values.add(property);
    else values.delete(property);
    const manual = { ...this.manual, [device]: [...values] };
    if (!values.size) delete manual[device];
    this.store.write('history-settings', manual);
    this.sync();
    return this.get(device, property);
  }
}
