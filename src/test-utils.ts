import { mock } from "bun:test";
import type { AgentMailClient } from "agentmail";
import type { Config } from "./config.js";
import type { Database } from "bun:sqlite";

export function createMockMailClient() {
  const reply = mock(() =>
    Promise.resolve({ messageId: "mock-reply-id" }),
  );
  const update = mock(() => Promise.resolve({}));
  const list = mock(() => Promise.resolve({ threads: [] as unknown[] }));
  const get = mock(() =>
    Promise.resolve({
      threadId: "",
      subject: undefined as string | undefined,
      messages: [] as unknown[],
    }),
  );

  const client = {
    inboxes: {
      messages: { reply, update },
      threads: { list, get },
    },
  } as unknown as AgentMailClient;

  return { client, mocks: { reply, update, list, get } };
}

export function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    inbox: "test-inbox",
    allowedDomains: ["example.com"],
    workDir: "/tmp/test-work",
    pollInterval: 300000,
    dbPath: ":memory:",
    model: "test-model",
    workerModel: "test-worker-model",
    maxTurns: 10,
    ...overrides,
  };
}

export function insertTestThread(
  db: Database,
  overrides?: Partial<{
    thread_id: string;
    inbox_id: string;
    sender: string;
    session_name: string;
    subject: string;
    status: string;
  }>,
) {
  const t = {
    thread_id: "t1",
    inbox_id: "test-inbox",
    sender: "user@example.com",
    session_name: "session-1",
    subject: "Test thread",
    status: "active",
    ...overrides,
  };
  db.run(
    `INSERT INTO threads (thread_id, inbox_id, sender, session_name, subject, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [t.thread_id, t.inbox_id, t.sender, t.session_name, t.subject, t.status],
  );
}

export function insertTestWindow(
  db: Database,
  threadId: string,
  overrides?: Partial<{
    window_name: string;
    worktree_path: string;
    branch_name: string;
    progress_file: string;
    task_summary: string;
    status: string;
  }>,
) {
  const w = {
    window_name: "test-window",
    worktree_path: "/tmp/wt",
    branch_name: "dispatch/test/window",
    progress_file: "/tmp/progress.json",
    task_summary: "Test task",
    status: "running",
    ...overrides,
  };
  db.run(
    `INSERT INTO windows (thread_id, window_name, worktree_path, branch_name, progress_file, task_summary, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [threadId, w.window_name, w.worktree_path, w.branch_name, w.progress_file, w.task_summary, w.status],
  );
}

export function insertTestMessage(
  db: Database,
  messageId: string,
  threadId: string,
) {
  db.run(
    "INSERT INTO messages_seen (message_id, thread_id) VALUES (?, ?)",
    [messageId, threadId],
  );
}
