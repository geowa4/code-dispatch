import { describe, test, expect } from "bun:test";
import { getLastMessageId } from "./mail.js";
import { initDatabase } from "./db.js";

describe("getLastMessageId", () => {
  test("returns message_id for existing thread", () => {
    const db = initDatabase(":memory:");

    // Insert prerequisite thread
    db.run(
      `INSERT INTO threads (thread_id, inbox_id, sender, session_name)
       VALUES (?, ?, ?, ?)`,
      ["t1", "inbox1", "user@example.com", "session-1"],
    );

    // Insert two messages, most recent should be returned
    db.run(
      `INSERT INTO messages_seen (message_id, thread_id, seen_at)
       VALUES (?, ?, ?)`,
      ["msg-1", "t1", "2026-01-01T00:00:00Z"],
    );
    db.run(
      `INSERT INTO messages_seen (message_id, thread_id, seen_at)
       VALUES (?, ?, ?)`,
      ["msg-2", "t1", "2026-01-01T01:00:00Z"],
    );

    const result = getLastMessageId(db, "t1");
    expect(result).toBe("msg-2");

    db.close();
  });

  test("throws for thread with no messages", () => {
    const db = initDatabase(":memory:");

    expect(() => getLastMessageId(db, "nonexistent")).toThrow(
      "No messages found for thread nonexistent",
    );

    db.close();
  });
});
