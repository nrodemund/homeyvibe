import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Tiny JSON-file persistence: one file per collection, written atomically.
 * Good enough for a home server's handful of users and pages; swap for SQLite later if needed.
 */
export class JsonStore {
  constructor(dir) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true });
    this.memory = new Map();
  }

  read(name, fallback) {
    if (!this.dir) return this.memory.has(name) ? structuredClone(this.memory.get(name)) : fallback;
    try {
      return JSON.parse(readFileSync(this.#path(name), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  write(name, value) {
    if (!this.dir) {
      this.memory.set(name, structuredClone(value));
      return;
    }
    const file = this.#path(name);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  #path(name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid store name ${name}`);
    return join(this.dir, `${name}.json`);
  }
}
