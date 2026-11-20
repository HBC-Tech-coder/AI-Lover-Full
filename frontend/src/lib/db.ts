/**
 * SQLite singleton for conversation logging.
 *
 * One physical file at <repo>/frontend/data/conversations.db.
 * Schema is created on first import; subsequent imports are no-ops.
 *
 * `sessions` rows are created when a WebSocket opens; `messages` rows are
 * appended for each user/assistant final transcript. Both writes go through
 * the /api/log/event route, never directly from the client.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "conversations.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      user_agent  TEXT,
      ip          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);
  `);

  _db = db;
  return db;
}
