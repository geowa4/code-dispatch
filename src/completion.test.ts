import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkerCompletion } from "./completion.js";
import { initDatabase } from "./db.js";
import {
  createMockMailClient,
  createTestConfig,
  insertTestMessage,
  insertTestThread,
  insertTestWindow,
} from "./test-utils.js";
import type { TmuxController } from "./tmux.js";

const tmpDir = join(import.meta.dir, "../.test-tmp-completion");

function createMockTmux(isIdleResult: boolean | Error = true) {
  const isIdle = mock(() => {
    if (isIdleResult instanceof Error) throw isIdleResult;
    return Promise.resolve(isIdleResult);
  });
  const factory = (_session: string) =>
    ({ isIdle }) as unknown as TmuxController;
  return { factory, isIdle };
}

describe("checkWorkerCompletion", () => {
  let db: Database;
  const config = createTestConfig();

  beforeEach(() => {
    db = initDatabase(":memory:");
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProgress(
    filename: string,
    data: Record<string, unknown>,
  ): string {
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
    const { factory } = createMockTmux(true);
    const progressFile = writeProgress("done.json", {
      status: "done",
      percent_complete: 100,
      current_step: "done",
      summary: "All tasks completed",
      steps_completed: ["step 1", "step 2"],
      errors: [],
      updated_at: new Date().toISOString(),
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config, factory);

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
    const { factory } = createMockTmux(true);
    const progressFile = writeProgress("error.json", {
      status: "error",
      percent_complete: 30,
      current_step: "building",
      summary: "Build failed",
      steps_completed: [],
      errors: ["compilation error in main.ts"],
      updated_at: new Date().toISOString(),
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config, factory);

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
    const { factory } = createMockTmux(false);
    const progressFile = writeProgress("done2.json", {
      status: "done",
      percent_complete: 100,
      current_step: "done",
      summary: "Done",
      steps_completed: ["done"],
      errors: [],
      updated_at: new Date().toISOString(),
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config, factory);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("skips windows where progress status is still running", async () => {
    const { client, mocks } = createMockMailClient();
    const { factory } = createMockTmux(true);
    const progressFile = writeProgress("running.json", {
      status: "running",
      percent_complete: 50,
      current_step: "working",
      summary: "Still working",
      steps_completed: ["step 1"],
      errors: [],
      updated_at: new Date().toISOString(),
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config, factory);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("skips windows with no progress file", async () => {
    const { client, mocks } = createMockMailClient();
    const { factory } = createMockTmux(true);
    // Use default nonexistent progress file path
    seedRunningWorker();

    await checkWorkerCompletion(db, client, config, factory);

    expect(mocks.reply).not.toHaveBeenCalled();

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("handles tmux session gone — sends error reply and marks window as error", async () => {
    const { client, mocks } = createMockMailClient();
    const { factory } = createMockTmux(new Error("tmux session not found"));
    seedRunningWorker();

    await checkWorkerCompletion(db, client, config, factory);

    expect(mocks.reply).toHaveBeenCalledTimes(1);
    const replyArgs = mocks.reply.mock.calls[0] as unknown[];
    const replyBody = (replyArgs[2] as { text: string }).text;
    expect(replyBody).toContain("tmux session was terminated");

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("error");
  });

  test("still marks window done even when replyToThread fails", async () => {
    const { client, mocks } = createMockMailClient();
    mocks.reply.mockRejectedValueOnce(new Error("mail API down"));

    const { factory } = createMockTmux(true);
    const progressFile = writeProgress("done-noreply.json", {
      status: "done",
      percent_complete: 100,
      current_step: "done",
      summary: "All tasks completed",
      steps_completed: ["step 1"],
      errors: [],
      updated_at: new Date().toISOString(),
    });
    seedRunningWorker({ progressFile });

    await checkWorkerCompletion(db, client, config, factory);

    // Window should still be marked done despite reply failure
    const win = db
      .query("SELECT status, last_reply_id FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string; last_reply_id: string | null };
    expect(win.status).toBe("done");
    expect(win.last_reply_id).toBeNull();

    // Thread should also be marked done
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("done");
  });

  test("detects stale thread — active with all windows done", async () => {
    const { client } = createMockMailClient();
    const { factory } = createMockTmux(true);

    // Create a thread that is active but has only completed windows
    insertTestThread(db, {
      thread_id: "stale-1",
      session_name: "session-stale",
      status: "active",
    });
    insertTestWindow(db, "stale-1", {
      window_name: "done-window",
      task_summary: "Already done",
      status: "done",
    });

    await checkWorkerCompletion(db, client, config, factory);

    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("stale-1") as { status: string };
    expect(thread.status).toBe("done");
  });

  test("detects stale thread with errors — marks as error", async () => {
    const { client } = createMockMailClient();
    const { factory } = createMockTmux(true);

    insertTestThread(db, {
      thread_id: "stale-2",
      session_name: "session-stale2",
      status: "active",
    });
    insertTestWindow(db, "stale-2", {
      window_name: "err-window",
      task_summary: "Failed task",
      status: "error",
    });
    insertTestWindow(db, "stale-2", {
      window_name: "done-window",
      task_summary: "Done task",
      status: "done",
    });

    await checkWorkerCompletion(db, client, config, factory);

    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("stale-2") as { status: string };
    expect(thread.status).toBe("error");
  });

  test("thread with mixed done/error windows is marked error", async () => {
    const { client } = createMockMailClient();
    const progressFile = writeProgress("done-mixed.json", {
      status: "done",
      percent_complete: 100,
      current_step: "done",
      summary: "Done",
      steps_completed: ["done"],
      errors: [],
      updated_at: new Date().toISOString(),
    });

    // Seed thread with one running (about to complete) and one already errored
    insertTestThread(db, {
      thread_id: "t1",
      session_name: "session-1",
      status: "active",
    });
    insertTestWindow(db, "t1", {
      window_name: "window-ok",
      task_summary: "Good task",
      status: "running",
      progress_file: progressFile,
    });
    insertTestWindow(db, "t1", {
      window_name: "window-bad",
      task_summary: "Bad task",
      status: "error",
    });
    insertTestMessage(db, "msg-1", "t1");

    const { factory } = createMockTmux(true);

    await checkWorkerCompletion(db, client, config, factory);

    // Thread should be error because one window errored
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("error");
  });

  test("does not mark thread done if other windows still running", async () => {
    const { client } = createMockMailClient();
    const progressFile = writeProgress("done3.json", {
      status: "done",
      percent_complete: 100,
      current_step: "done",
      summary: "Done",
      steps_completed: ["done"],
      errors: [],
      updated_at: new Date().toISOString(),
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
    const factory = (_session: string) =>
      ({
        isIdle: mock(() => {
          callCount++;
          return Promise.resolve(callCount === 1);
        }),
      }) as unknown as TmuxController;

    await checkWorkerCompletion(db, client, config, factory);

    // Thread should still be active since window-b is still running
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("active");
  });
});
