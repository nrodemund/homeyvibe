import { DAY, HISTORY_RANGES, HOUR, MINUTE } from './history-db.js';

const MAX_SERIES = 512;
const MAX_POINTS = 121;
const TIERS = [5 * MINUTE, HOUR, 4 * HOUR];
const RETENTION = [DAY, 30 * DAY];

/** Keep one-minute recent readings, retain selected series on disk, and record discrete activity. */
export class DeviceHistory {
  #series = new Map();
  #events = new Map();
  #tracked = new Map();

  constructor(now = Date.now, db = null) {
    this.now = now;
    this.db = db;
    if (!db) return;
    this.writeReading = db.prepare(`
      INSERT INTO readings (device, property, tier, bucket, time, value) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (device, property, tier, bucket) DO UPDATE SET time = excluded.time, value = excluded.value
      WHERE excluded.time >= readings.time
    `);
    this.readSeries = db.prepare(`
      SELECT time, value FROM readings WHERE device = ? AND property = ? AND tier = ? AND time >= ? AND time < ?
      ORDER BY bucket DESC LIMIT 20000
    `);
    this.writeEvent = db.prepare('INSERT INTO activity (device, time, kind, property, value) VALUES (?, ?, ?, ?, ?)');
    this.readEvents = db.prepare('SELECT id, time, kind, property, value FROM activity WHERE device = ? AND id < ? ORDER BY id DESC LIMIT 100');
    this.lastStateEvent = db.prepare("SELECT value FROM activity WHERE device = ? AND property = ? AND kind = 'state' ORDER BY id DESC LIMIT 1");
    this.removeReadings = db.prepare('DELETE FROM readings WHERE tier = ? AND time < ?');
    this.prune();
    this.pruneTimer = setInterval(() => {
      try { this.prune(); } catch (err) { console.error('Could not prune device history:', err.message); }
    }, HOUR).unref();
  }

  setTracked(entries) {
    this.#tracked = entries;
  }

  tracked(id, property) {
    return this.#tracked.get(id)?.has(property) ?? false;
  }

  record(device, changes, previous = {}, metadata = {}) {
    const time = this.now();
    for (const { property, type, readable } of device.capabilities ?? []) {
      if (!readable || !Object.hasOwn(changes, property)) continue;
      const value = changes[property];
      const known = Object.hasOwn(previous, property);
      const changed = !known || previous[property] !== value;
      const discrete = ['binary', 'enum'].includes(type);
      const stateChanged = discrete && changed && (known ||
        this.lastStateEvent?.get(device.id, property)?.value !== JSON.stringify(value));
      if (!metadata.retained && (metadata.eventProperties?.includes(property) || stateChanged)) {
        this.event(device.id, 'state', property, value);
        metadata.onActivity?.({ kind: 'state', property, value });
      }
      if (type !== 'numeric' || !Number.isFinite(value) || !changed) continue;
      if (known && !metadata.retained) metadata.onActivity?.({ kind: 'reading', property, value });
      const key = JSON.stringify([device.id, property]);
      const points = this.#series.get(key) ?? [];
      const last = points.at(-1);
      const persisted = this.db && this.tracked(device.id, property);
      const latest = persisted && !known ? this.readSeries.get(device.id, property, TIERS[2], 0, time + 1) : null;
      if (!last && latest?.value === value) continue;
      const sample = [time, value];
      if (last && Math.floor(last[0] / MINUTE) === Math.floor(time / MINUTE)) {
        points[points.length - 1] = sample;
      } else {
        points.push(sample);
        if (points.length > MAX_POINTS) points.shift();
      }
      this.#series.delete(key);
      this.#series.set(key, points);
      if (this.#series.size > MAX_SERIES) this.#series.delete(this.#series.keys().next().value);
      if (persisted) {
        this.db.exec('BEGIN');
        try {
          for (const tier of TIERS) this.writeReading.run(device.id, property, tier, Math.floor(time / tier), time, value);
          this.db.exec('COMMIT');
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      }
    }
  }

  get(id, property, range = '24h') {
    const now = this.now();
    const cutoff = Math.max(0, now - HISTORY_RANGES[range]);
    const recent = (this.#series.get(JSON.stringify([id, property])) ?? []).filter(([time]) => time >= Math.max(cutoff, now - 2 * HOUR));
    if (!this.db) return recent;
    const points = [];
    let end = recent[0]?.[0] ?? now + 1;
    for (const [i, tier] of TIERS.entries()) {
      if (end <= cutoff) break;
      const start = Math.max(cutoff, now - (RETENTION[i] ?? Infinity));
      const rows = this.readSeries.all(id, property, tier, start, end);
      points.unshift(...rows.reverse().map(({ time, value }) => [time, value]));
      end = Math.min(end, start);
    }
    return points.concat(recent);
  }

  event(device, kind, property, value) {
    if (value === undefined) return;
    const json = JSON.stringify(value);
    if (json.length > 4096) return;
    const time = this.now();
    if (this.db) {
      this.writeEvent.run(device, time, kind, property, json);
      return;
    }
    const events = this.#events.get(device) ?? [];
    events.unshift({ id: (events[0]?.id ?? 0) + 1, time, kind, property, value });
    this.#events.delete(device);
    this.#events.set(device, events.slice(0, 100));
    if (this.#events.size > MAX_SERIES) this.#events.delete(this.#events.keys().next().value);
  }

  activity(device, before = Number.MAX_SAFE_INTEGER) {
    if (this.db) return this.readEvents.all(device, before).map((row) => ({ ...row, value: JSON.parse(row.value) }));
    return (this.#events.get(device) ?? []).filter((event) => event.id < before);
  }

  prune() {
    for (const [i, duration] of RETENTION.entries()) this.removeReadings.run(TIERS[i], this.now() - duration);
  }

  close() {
    clearInterval(this.pruneTimer);
    this.db?.close();
  }
}
