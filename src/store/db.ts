import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type DB = Database.Database;

export function openDb(path: string): DB {
  const isFile = path !== ':memory:';
  if (isFile) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = isFile && !existsSync(path);
  const db = new Database(path);
  // Transcripts can contain secrets; keep the DB readable by the owner only.
  if (fresh) chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const [i, sql] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (version <= current) continue;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
