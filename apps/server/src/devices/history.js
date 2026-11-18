import { HISTORY_BUCKET_MS, HISTORY_WINDOW_MS } from '../../../../packages/shared/src/floorplan.js';

const MAX_SERIES = 512;
const MAX_POINTS = HISTORY_WINDOW_MS / HISTORY_BUCKET_MS + 1;

/** Keep the latest reading per five-minute interval, using bounded memory and no polling. */
export class DeviceHistory {
  #series = new Map();

  constructor(now = Date.now) {
    this.now = now;
  }

  record(device, changes) {
    const time = this.now();
    for (const { property, type, readable } of device.capabilities ?? []) {
      if (type !== 'numeric' || !readable || !Object.hasOwn(changes, property) || !Number.isFinite(changes[property])) continue;
      const key = JSON.stringify([device.id, property]);
      const points = this.#series.get(key) ?? [];
      const last = points.at(-1);
      const sample = [time, changes[property]];
      if (last && Math.floor(last[0] / HISTORY_BUCKET_MS) === Math.floor(time / HISTORY_BUCKET_MS)) {
        points[points.length - 1] = sample;
      } else {
        points.push(sample);
        if (points.length > MAX_POINTS) points.shift();
      }
      this.#series.delete(key);
      this.#series.set(key, points);
      if (this.#series.size > MAX_SERIES) this.#series.delete(this.#series.keys().next().value);
    }
  }

  get(id, property) {
    const cutoff = this.now() - HISTORY_WINDOW_MS;
    return (this.#series.get(JSON.stringify([id, property])) ?? []).filter(([time]) => time >= cutoff);
  }
}
