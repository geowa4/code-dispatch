import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initDatabase } from "./db.js";
import { insertTestThread, insertTestWindow } from "./test-utils.js";
import type { TmuxController } from "./tmux.js";
import { cancelThreadImpl } from "./tools.js";

function createMockTmux(killWindowResult: "ok" | Error = "ok") {
  const killWindow = mock(() => {
    if (killWindowResult instanceof Error) throw killWindowResult;
    return Promise.resolve();
  });
  const killSession = mock(() => Promise.resolve());
  const factory = (_session: string) =>
    ({ killWindow, killSession }) as unknown as TmuxController;
  return { factory, killWindow, killSession };
}

function createMockWorktreeRemover(result: "ok" | Error = "ok") {
  return mock((_worktreePath: string) => {
    if (result instanceof Error) throw result;
  });
}

describe("cancelThreadImpl", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("returns error for unknown thread", async () => {
    const { factory } = createMockTmux();
    const result = await cancelThreadImpl(
      db,
      "nonexistent",
      factory,
      createMockWorktreeRemover(),
    );

    expect(result).toEqual({
      error: "Thread not found",
      thread_id: "nonexistent",
    });
  });

  test("cancels running windows — kills tmux, removes worktree, updates DB", async () => {
    const { factory, killWindow, killSession } = createMockTmux();
    const worktreeRemover = createMockWorktreeRemover();

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "fix-bug",
      worktree_path: "/tmp/wt-fix-bug",
      status: "running",
    });

    const result = (await cancelThreadImpl(
      db,
      "t1",
      factory,
      worktreeRemover,
    )) as {
      cancelled_windows: number;
      failed_windows: number;
      details: Array<{
        window: string;
        tmux: string;
        worktree: string;
        cancelled: boolean;
      }>;
    };

    expect(result.cancelled_windows).toBe(1);
    expect(result.failed_windows).toBe(0);
    expect(result.details[0]?.tmux).toBe("killed");
    expect(result.details[0]?.worktree).toBe("removed");
    expect(result.details[0]?.cancelled).toBe(true);

    expect(killWindow).toHaveBeenCalledWith("fix-bug");
    expect(worktreeRemover).toHaveBeenCalledWith("/tmp/wt-fix-bug");

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("cancelled");
  });

  test("does not mark window cancelled if tmux kill fails", async () => {
    const { factory, killWindow } = createMockTmux(
      new Error("tmux kill failed"),
    );
    const worktreeRemover = createMockWorktreeRemover();

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "fix-bug",
      worktree_path: "/tmp/wt-fix-bug",
      status: "running",
    });

    const result = (await cancelThreadImpl(
      db,
      "t1",
      factory,
      worktreeRemover,
    )) as {
      cancelled_windows: number;
      failed_windows: number;
      details: Array<{
        window: string;
        tmux: string;
        worktree: string;
        cancelled: boolean;
      }>;
    };

    expect(result.cancelled_windows).toBe(0);
    expect(result.failed_windows).toBe(1);
    expect(result.details[0]?.tmux).toBe("failed");
    expect(result.details[0]?.worktree).toBe("skipped");
    expect(result.details[0]?.cancelled).toBe(false);

    expect(killWindow).toHaveBeenCalledWith("fix-bug");
    expect(worktreeRemover).not.toHaveBeenCalled();

    // Window should still be running
    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("running");
  });

  test("does not kill session if running windows remain", async () => {
    // First window kill succeeds, second fails
    let callCount = 0;
    const killWindow = mock(() => {
      callCount++;
      if (callCount === 2) throw new Error("tmux kill failed");
      return Promise.resolve();
    });
    const killSession = mock(() => Promise.resolve());
    const factory = (_session: string) =>
      ({ killWindow, killSession }) as unknown as TmuxController;
    const worktreeRemover = createMockWorktreeRemover();

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "window-a",
      worktree_path: "/tmp/wt-a",
      status: "running",
    });
    insertTestWindow(db, "t1", {
      window_name: "window-b",
      worktree_path: "/tmp/wt-b",
      status: "running",
    });

    const result = (await cancelThreadImpl(
      db,
      "t1",
      factory,
      worktreeRemover,
    )) as {
      cancelled_windows: number;
      failed_windows: number;
    };

    expect(result.cancelled_windows).toBe(1);
    expect(result.failed_windows).toBe(1);

    // Session should NOT be killed since window-b is still running
    expect(killSession).not.toHaveBeenCalled();

    // Thread should still be active
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("active");
  });

  test("kills session and marks thread done when all windows cancelled", async () => {
    const { factory, killSession } = createMockTmux();
    const worktreeRemover = createMockWorktreeRemover();

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "fix-bug",
      status: "running",
    });

    await cancelThreadImpl(db, "t1", factory, worktreeRemover);

    expect(killSession).toHaveBeenCalled();

    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("done");
  });

  test("skips already-completed windows", async () => {
    const { factory, killWindow, killSession } = createMockTmux();
    const worktreeRemover = createMockWorktreeRemover();

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "done-window",
      status: "done",
    });

    const result = (await cancelThreadImpl(
      db,
      "t1",
      factory,
      worktreeRemover,
    )) as {
      cancelled_windows: number;
      details: unknown[];
    };

    // No running windows to cancel
    expect(result.cancelled_windows).toBe(0);
    expect(result.details).toHaveLength(0);
    expect(killWindow).not.toHaveBeenCalled();

    // But session should still be killed (no running windows remain)
    // and thread marked done
    expect(killSession).toHaveBeenCalled();
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("done");
  });

  test("handles worktree removal failure gracefully — still marks cancelled", async () => {
    const { factory } = createMockTmux();
    const worktreeRemover = createMockWorktreeRemover(
      new Error("worktree remove failed"),
    );

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "fix-bug",
      status: "running",
    });

    const result = (await cancelThreadImpl(
      db,
      "t1",
      factory,
      worktreeRemover,
    )) as {
      cancelled_windows: number;
      details: Array<{ tmux: string; worktree: string; cancelled: boolean }>;
    };

    // tmux kill succeeded so window is cancelled, even though worktree removal failed
    expect(result.cancelled_windows).toBe(1);
    expect(result.details[0]?.tmux).toBe("killed");
    expect(result.details[0]?.worktree).toBe("failed");
    expect(result.details[0]?.cancelled).toBe(true);

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("cancelled");
  });

  test("marks thread error when cancelling leaves error windows behind", async () => {
    const { factory } = createMockTmux();
    const worktreeRemover = createMockWorktreeRemover();

    insertTestThread(db, { thread_id: "t1", session_name: "session-1" });
    insertTestWindow(db, "t1", {
      window_name: "errored-earlier",
      status: "error",
    });
    insertTestWindow(db, "t1", {
      window_name: "still-running",
      status: "running",
    });

    await cancelThreadImpl(db, "t1", factory, worktreeRemover);

    // Thread should be "error" (not "done") because one window has error status
    const thread = db
      .query("SELECT status FROM threads WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(thread.status).toBe("error");
  });
});
