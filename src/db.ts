import { Database } from "bun:sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id     TEXT PRIMARY KEY,
  inbox_id      TEXT NOT NULL,
  subject       TEXT,
  sender        TEXT NOT NULL,
  repo_path     TEXT,
  session_name  TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'done', 'error')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS windows (
  window_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id),
  window_name   TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  progress_file TEXT NOT NULL,
  task_summary  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'done', 'error', 'cancelled')),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  last_reply_id TEXT
);

CREATE TABLE IF NOT EXISTS messages_seen (
  message_id    TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id),
  seen_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_windows_thread ON windows(thread_id);
CREATE INDEX IF NOT EXISTS idx_windows_status ON windows(status);
`;

export function initDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export interface ThreadRow {
  thread_id: string;
  inbox_id: string;
  subject: string | null;
  sender: string;
  repo_path: string | null;
  session_name: string;
  status: "active" | "paused" | "done" | "error";
  created_at: string;
  updated_at: string;
}

export interface WindowRow {
  window_id: number;
  thread_id: string;
  window_name: string;
  worktree_path: string;
  branch_name: string;
  progress_file: string;
  task_summary: string;
  status: "running" | "done" | "error" | "cancelled";
  started_at: string;
  finished_at: string | null;
  last_reply_id: string | null;
}
