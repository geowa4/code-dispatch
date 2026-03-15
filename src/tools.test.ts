import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "./db.js";
import { cancelThreadImpl } from "./tools.js";
import {
  createMockMailClient,
  insertTestThread,
  insertTestWindow,
  insertTestMessage,
} from "./test-utils.js";
import { getLastMessageId, replyToThread } from "./mail.js";

describe("getLastMessageId edge cases", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("throws for thread with no messages_seen entries", () => {
    insertTestThread(db, { thread_id: "t1" });

    expect(() => getLastMessageId(db, "t1")).toThrow(
      "No messages found for thread t1",
    );
  });
});

describe("cancelThreadImpl edge cases", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("marks thread error when mix includes error windows", async () => {
    const killWindow = () => Promise.resolve();
    const killSession = () => Promise.resolve();
    const factory = (_s: string) =>
      ({ killWindow, killSession }) as unknown as import("./tmux.js").TmuxController;
    const remover = (_wp: string) => {};

    insertTestThread(db, { thread_id: "t1", session_name: "s1" });
    insertTestWindow(db, "t1", { window_name: "w1", status: "done" });
    insertTestWindow(db, "t1", { window_name: "w2", status: "error" });
    insertTestWindow(db, "t1", { window_name: "w3", status: "running" });

    const result = (await cancelThreadImpl(db, "t1", factory, remover)) as {
      cancelled_windows: number;
    };

    expect(result.cancelled_windows).toBe(1);

    // Thread should be "error" because w2 has error status
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("error");
  });

  test("handles thread with only non-running windows", async () => {
    const killSession = () => Promise.resolve();
    const factory = (_s: string) =>
      ({
        killWindow: () => Promise.resolve(),
        killSession,
      }) as unknown as import("./tmux.js").TmuxController;
    const remover = (_wp: string) => {};

    insertTestThread(db, { thread_id: "t1", session_name: "s1" });
    insertTestWindow(db, "t1", { window_name: "w1", status: "done" });
    insertTestWindow(db, "t1", { window_name: "w2", status: "done" });

    const result = (await cancelThreadImpl(db, "t1", factory, remover)) as {
      cancelled_windows: number;
      details: unknown[];
    };

    expect(result.cancelled_windows).toBe(0);
    expect(result.details).toHaveLength(0);

    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("done");
  });
});

describe("replyToThread edge cases", () => {
  test("handles reply API failure by throwing", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.reply.mockRejectedValueOnce(new Error("API down"));

    await expect(
      replyToThread(client, "inbox-1", "t1", "msg-1", "Hello"),
    ).rejects.toThrow("API down");
  });
});
