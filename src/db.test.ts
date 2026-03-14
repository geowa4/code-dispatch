import { describe, test, expect } from "bun:test";
import { initDatabase } from "./db.js";

describe("initDatabase", () => {
  test("creates tables and returns usable db", () => {
    const db = initDatabase(":memory:");

    // Verify tables exist by querying sqlite_master
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("threads");
    expect(tableNames).toContain("windows");
    expect(tableNames).toContain("messages_seen");

    db.close();
  });

  test("can insert and query thread rows", () => {
    const db = initDatabase(":memory:");

    db.run(
      `INSERT INTO threads (thread_id, inbox_id, sender, session_name)
       VALUES (?, ?, ?, ?)`,
      ["t1", "inbox1", "user@example.com", "session-1"],
    );

    const row = db
      .query("SELECT * FROM threads WHERE thread_id = ?")
      .get("t1") as Record<string, unknown>;

    expect(row.thread_id).toBe("t1");
    expect(row.sender).toBe("user@example.com");
    expect(row.status).toBe("active"); // default

    db.close();
  });

  test("can insert and query window rows", () => {
    const db = initDatabase(":memory:");

    db.run(
      `INSERT INTO threads (thread_id, inbox_id, sender, session_name)
       VALUES (?, ?, ?, ?)`,
      ["t1", "inbox1", "user@example.com", "session-1"],
    );

    db.run(
      `INSERT INTO windows (thread_id, window_name, worktree_path, branch_name, progress_file, task_summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["t1", "win-1", "/tmp/wt", "feat/x", "/tmp/progress.json", "Do stuff"],
    );

    const row = db
      .query("SELECT * FROM windows WHERE thread_id = ?")
      .get("t1") as Record<string, unknown>;

    expect(row.window_name).toBe("win-1");
    expect(row.status).toBe("running"); // default

    db.close();
  });

  test("enforces foreign key on windows", () => {
    const db = initDatabase(":memory:");

    expect(() => {
      db.run(
        `INSERT INTO windows (thread_id, window_name, worktree_path, branch_name, progress_file, task_summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "nonexistent",
          "win-1",
          "/tmp/wt",
          "feat/x",
          "/tmp/progress.json",
          "Do stuff",
        ],
      );
    }).toThrow();

    db.close();
  });
});
