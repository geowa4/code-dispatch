import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initDatabase } from "./db.js";
import {
  createMockMailClient,
  createTestConfig,
  insertTestMessage,
  insertTestThread,
} from "./test-utils.js";

// Mock the Claude Agent SDK query function
const mockQueryEvents: Array<{ type: string; subtype?: string }> = [];
let mockQueryError: Error | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: async function* (_opts: unknown) {
    if (mockQueryError) throw mockQueryError;
    for (const event of mockQueryEvents) {
      yield event;
    }
  },
}));

// Dynamic import after mocking
const { handleMessage } = await import("./orchestrator.js");

describe("handleMessage", () => {
  let db: Database;
  const config = createTestConfig();

  beforeEach(() => {
    db = initDatabase(":memory:");
    mockQueryEvents.length = 0;
    mockQueryError = null;
  });

  test("creates thread row for new thread", async () => {
    const { client } = createMockMailClient();
    mockQueryEvents.push({ type: "result", subtype: "success" });

    const fakeTools = {} as ReturnType<
      typeof import("./tools.js").createOrchestratorTools
    >;

    await handleMessage(
      { threadId: "t1", subject: "Test" },
      { messageId: "m1", from: "user@example.com" },
      config,
      db,
      client,
      fakeTools,
    );

    const thread = db
      .query("SELECT * FROM threads WHERE thread_id = ?")
      .get("t1") as {
      thread_id: string;
      session_name: string;
      sender: string;
    } | null;
    expect(thread).not.toBeNull();
    expect(thread?.session_name).toStartWith("dispatch-");
    expect(thread?.sender).toBe("user@example.com");
  });

  test("reuses existing thread row", async () => {
    const { client } = createMockMailClient();
    mockQueryEvents.push({ type: "result", subtype: "success" });
    insertTestThread(db, {
      thread_id: "t1",
      session_name: "dispatch-existing",
    });

    const fakeTools = {} as ReturnType<
      typeof import("./tools.js").createOrchestratorTools
    >;

    await handleMessage(
      { threadId: "t1", subject: "Test" },
      { messageId: "m1", from: "user@example.com" },
      config,
      db,
      client,
      fakeTools,
    );

    // Should still be the same session name (not recreated)
    const thread = db
      .query("SELECT session_name FROM threads WHERE thread_id = ?")
      .get("t1") as { session_name: string };
    expect(thread.session_name).toBe("dispatch-existing");
  });

  test("catches query errors and sends error reply", async () => {
    const { client, mocks } = createMockMailClient();
    mockQueryError = new Error("SDK explosion");

    insertTestThread(db, { thread_id: "t1" });
    insertTestMessage(db, "m1", "t1");

    const fakeTools = {} as ReturnType<
      typeof import("./tools.js").createOrchestratorTools
    >;

    // Should not throw
    await handleMessage(
      { threadId: "t1", subject: "Test" },
      { messageId: "m1", from: "user@example.com" },
      config,
      db,
      client,
      fakeTools,
    );

    // Should have sent an error reply
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    const replyArgs = mocks.reply.mock.calls[0] as unknown[];
    const replyBody = (replyArgs[2] as { text: string }).text;
    expect(replyBody).toContain("Internal error");
  });

  test("catches query errors gracefully when no messages exist for reply", async () => {
    const { client, mocks } = createMockMailClient();
    mockQueryError = new Error("SDK explosion");

    // Thread exists but no messages_seen — getLastMessageId will throw
    const fakeTools = {} as ReturnType<
      typeof import("./tools.js").createOrchestratorTools
    >;

    // Should not throw even though error reply fails
    await handleMessage(
      { threadId: "new-thread", subject: "Test" },
      { messageId: "m1", from: "user@example.com" },
      config,
      db,
      client,
      fakeTools,
    );

    // No reply sent (getLastMessageId threw)
    expect(mocks.reply).not.toHaveBeenCalled();
  });
});
