import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initDatabase } from "./db.js";
import { getLastMessageId, pollInbox, replyToThread } from "./mail.js";
import {
  createMockMailClient,
  createTestConfig,
  insertTestMessage,
  insertTestThread,
} from "./test-utils.js";

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

describe("replyToThread", () => {
  test("calls reply and update, returns messageId", async () => {
    const { client, mocks } = createMockMailClient();

    const result = await replyToThread(
      client,
      "inbox-1",
      "thread-1",
      "msg-1",
      "Hello world",
    );

    expect(result).toBe("mock-reply-id");

    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply).toHaveBeenCalledWith("inbox-1", "msg-1", {
      text: "Hello world",
      html: expect.stringContaining("Hello world"),
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("inbox-1", "msg-1", {
      addLabels: ["replied"],
      removeLabels: ["unreplied"],
    });
  });

  test("HTML-escapes the body in the html field", async () => {
    const { client, mocks } = createMockMailClient();

    await replyToThread(
      client,
      "inbox-1",
      "thread-1",
      "msg-1",
      '<script>alert("xss")</script>',
    );

    const htmlArg = (mocks.reply.mock.calls[0] as unknown[])[2] as {
      html: string;
    };
    expect(htmlArg.html).toContain("&lt;script&gt;");
    expect(htmlArg.html).toContain("&quot;xss&quot;");
    expect(htmlArg.html).not.toContain("<script>");
  });
});

describe("pollInbox", () => {
  let db: Database;
  const config = createTestConfig();

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("processes unseen message from allowed domain", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }],
    });
    mocks.get.mockResolvedValueOnce({
      threadId: "t1",
      subject: "Test subject",
      messages: [
        {
          messageId: "m1",
          from: "user@example.com",
          text: "Do the thing",
        },
      ],
    });

    // Need a thread row for FK constraint on messages_seen insert
    insertTestThread(db, { thread_id: "t1" });

    const handleMessage = mock(() => Promise.resolve());
    await pollInbox(client, config, db, handleMessage);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith(
      { threadId: "t1", subject: "Test subject" },
      expect.objectContaining({
        messageId: "m1",
        from: "user@example.com",
        text: "Do the thing",
      }),
    );

    // Verify message recorded in DB
    const seen = db
      .query("SELECT 1 FROM messages_seen WHERE message_id = ?")
      .get("m1");
    expect(seen).toBeTruthy();
  });

  test("skips messages from disallowed domains", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }],
    });
    mocks.get.mockResolvedValueOnce({
      threadId: "t1",
      subject: "Evil",
      messages: [
        { messageId: "m1", from: "hacker@evil.com", text: "bad stuff" },
      ],
    });

    const handleMessage = mock(() => Promise.resolve());
    await pollInbox(client, config, db, handleMessage);

    expect(handleMessage).not.toHaveBeenCalled();
  });

  test("skips already-seen messages", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }],
    });
    mocks.get.mockResolvedValueOnce({
      threadId: "t1",
      subject: "Test",
      messages: [{ messageId: "m1", from: "user@example.com", text: "hello" }],
    });

    // Pre-insert thread and message as already seen
    insertTestThread(db, { thread_id: "t1" });
    insertTestMessage(db, "m1", "t1");

    const handleMessage = mock(() => Promise.resolve());
    await pollInbox(client, config, db, handleMessage);

    expect(handleMessage).not.toHaveBeenCalled();
  });

  test("handles multiple threads", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }, { threadId: "t2" }],
    });
    mocks.get
      .mockResolvedValueOnce({
        threadId: "t1",
        subject: "First",
        messages: [{ messageId: "m1", from: "a@example.com", text: "first" }],
      })
      .mockResolvedValueOnce({
        threadId: "t2",
        subject: "Second",
        messages: [{ messageId: "m2", from: "b@example.com", text: "second" }],
      });

    insertTestThread(db, { thread_id: "t1", session_name: "s1" });
    insertTestThread(db, { thread_id: "t2", session_name: "s2" });

    const handleMessage = mock(() => Promise.resolve());
    await pollInbox(client, config, db, handleMessage);

    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  test("does not mark message seen when handleMessage throws", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }],
    });
    mocks.get.mockResolvedValueOnce({
      threadId: "t1",
      subject: "Crash test",
      messages: [
        { messageId: "m1", from: "user@example.com", text: "cause crash" },
      ],
    });

    insertTestThread(db, { thread_id: "t1" });

    const handleMessage = mock(() =>
      Promise.reject(new Error("handler crash")),
    );

    await expect(pollInbox(client, config, db, handleMessage)).rejects.toThrow(
      "handler crash",
    );

    // Message should NOT be in messages_seen since handleMessage threw before insert
    const seen = db
      .query("SELECT 1 FROM messages_seen WHERE message_id = ?")
      .get("m1");
    expect(seen).toBeNull();
  });

  test("skips messages with malformed from address", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }],
    });
    mocks.get.mockResolvedValueOnce({
      threadId: "t1",
      subject: "Weird sender",
      messages: [
        { messageId: "m1", from: undefined, text: "hello" },
        { messageId: "m2", from: "", text: "hello" },
        { messageId: "m3", from: "no-at-sign", text: "hello" },
      ],
    });

    const handleMessage = mock(() => Promise.resolve());
    await pollInbox(client, config, db, handleMessage);

    expect(handleMessage).not.toHaveBeenCalled();
  });

  test("skips threads with no messages", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.list.mockResolvedValueOnce({
      threads: [{ threadId: "t1" }],
    });
    mocks.get.mockResolvedValueOnce({
      threadId: "t1",
      subject: "Empty",
      messages: [],
    });

    const handleMessage = mock(() => Promise.resolve());
    await pollInbox(client, config, db, handleMessage);

    expect(handleMessage).not.toHaveBeenCalled();
  });
});
