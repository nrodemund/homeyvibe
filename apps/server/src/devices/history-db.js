import { chmodSync } from 'node:fs';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const HISTORY_RANGES = { '2h': 2 * HOUR, '24h': DAY, '30d': 30 * DAY, all: Infinity };

/** Open the local history database using the SQLite provided by Node 22. */
export function openHistoryDatabase(path) {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite) throw new Error('History persistence requires Node 22.13 or newer');
  const db = new sqlite.DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS readings (
      device TEXT NOT NULL, property TEXT NOT NULL, tier INTEGER NOT NULL,
      bucket INTEGER NOT NULL, time INTEGER NOT NULL, value REAL NOT NULL,
      PRIMARY KEY (device, property, tier, bucket)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS readings_expiry ON readings (tier, time);
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY, device TEXT NOT NULL, time INTEGER NOT NULL,
      kind TEXT NOT NULL, property TEXT, value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_by_device ON activity (device, id DESC);
  `);
  return db;
}
