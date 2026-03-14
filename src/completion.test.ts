import { describe, test, expect, beforeEach, afterEach, mock, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "./db.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createMockMailClient,
  createTestConfig,
  insertTestThread,
  insertTestWindow,
  insertTestMessage,
} from "./test-utils.js";

// Mock TmuxController before importing completion (no other test file uses tmux)
const mockIsIdle = mock(() => Promise.resolve(true));

mock.module("./tmux.js", () => ({
  TmuxController: class MockTmuxController {
    constructor(_session: string) {}
    isIdle = mockIsIdle;
    ensureSession = mock(() => Promise.resolve());
    sendKeys = mock(() => Promise.resolve());
  },
}));

let checkWorkerCompletion: typeof import("./completion.js").checkWorkerCompletion;

beforeAll(async () => {
  const mod = await import("./completion.js");
  checkWorkerCompletion = mod.checkWorkerCompletion;
});

const tmpDir = join(import.meta.dir, "../.test-tmp-completion");

describe("checkWorkerCompletion", () => {
  let db: Database;
  const config = createTestConfig();

  beforeEach(() => {
    db = initDatabase(":memory:");
    mockIsIdle.mockReset();
    mockIsIdle.mockImplementation(() => Promise.resolve(true));
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProgress(filename: string, data: Record<string, unknown>): string {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function seedRunningWorker(overrides?: {
    threadId?: string;
    sessionName?: string;
    windowName?: string;
    messageId?: string;
    taskSummary?: string;
    progressFile?: string;
  }) {
    const threadId = overrides?.threadId ?? "t1";
    const sessionName = overrides?.sessionName ?? "session-1";
    const messageId = overrides?.messageId ?? "msg-1";

    insertTestThread(db, {
      thread_id: threadId,
      session_name: sessionName,
      status: "active",
    });
    insertTestWindow(db, threadId, {
      window_name: overrides?.windowName ?? "test-window",
      task_summary: overrides?.taskSummary ?? "Fix the bug",
      status: "running",
      progress_file: overrides?.progressFile ?? "/nonexistent/progress.json",
    });
    insertTestMessage(db, messageId, threadId);
  }

  test("completes a done worker — sends success reply, updates DB", async () => {
    const { client, mocks } = createMockMailClient();
    const progressFile = writeProgress("done.json", {
      status: "done",
      summary: "All tasks completed",
      steps_completed: ["step 1", "step 2"],
      errors: [],
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config);

    // Verify reply was sent with success content
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    const replyArgs = mocks.reply.mock.calls[0] as unknown[];
    const replyBody = (replyArgs[2] as { text: string }).text;
    expect(replyBody).toContain("Task complete");
    expect(replyBody).toContain("All tasks completed");

    // Verify window status updated
    const win = db
      .query("SELECT status, last_reply_id FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string; last_reply_id: string };
    expect(win.status).toBe("done");
    expect(win.last_reply_id).toBe("mock-reply-id");

    // Verify thread marked done (no other running windows)
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("done");
  });

  test("completes an errored worker — sends error reply", async () => {
    const { client, mocks } = createMockMailClient();
    const progressFile = writeProgress("error.json", {
      status: "error",
      summary: "Build failed",
      steps_completed: [],
      errors: ["compilation error in main.ts"],
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config);

    expect(mocks.reply).toHaveBeenCalledTimes(1);
    const replyArgs = mocks.reply.mock.calls[0] as unknown[];
    const replyBody = (replyArgs[2] as { text: string }).text;
    expect(replyBody).toContain("Task failed");
    expect(replyBody).toContain("compilation error in main.ts");

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("error");
  });

  test("skips non-idle windows", async () => {
    const { client, mocks } = createMockMailClient();
    const progressFile = writeProgress("done2.json", {
      status: "done",
      summary: "Done",
      steps_completed: ["done"],
      errors: [],
    });
    seedRunningWorker({ progressFile });

    mockIsIdle.mockImplementation(() => Promise.resolve(false));

    await checkWorkerCompletion(db, client, config);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("skips windows where progress status is still running", async () => {
    const { client, mocks } = createMockMailClient();
    const progressFile = writeProgress("running.json", {
      status: "running",
      summary: "Still working",
      steps_completed: ["step 1"],
      errors: [],
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("skips windows with no progress file", async () => {
    const { client, mocks } = createMockMailClient();
    // Use default nonexistent progress file path
    seedRunningWorker();

    await checkWorkerCompletion(db, client, config);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("handles tmux session gone — marks window as error", async () => {
    const { client, mocks } = createMockMailClient();
    seedRunningWorker();

    mockIsIdle.mockImplementation(() => {
      throw new Error("tmux session not found");
    });

    await checkWorkerCompletion(db, client, config);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("error");
  });

  test("does not mark thread done if other windows still running", async () => {
    const { client } = createMockMailClient();
    const progressFile = writeProgress("done3.json", {
      status: "done",
      summary: "Done",
      steps_completed: ["done"],
      errors: [],
    });

    // Seed a thread with two windows
    insertTestThread(db, {
      thread_id: "t1",
      session_name: "session-1",
      status: "active",
    });
    insertTestWindow(db, "t1", {
      window_name: "window-a",
      task_summary: "First task",
      status: "running",
      progress_file: progressFile,
    });
    insertTestWindow(db, "t1", {
      window_name: "window-b",
      task_summary: "Second task",
      status: "running",
      progress_file: "/nonexistent/progress-b.json",
    });
    insertTestMessage(db, "msg-1", "t1");

    // Only first window is idle+done; second is not idle
    let callCount = 0;
    mockIsIdle.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1);
    });

    await checkWorkerCompletion(db, client, config);

    // Thread should still be active since window-b is still running
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("active");
  });
});
