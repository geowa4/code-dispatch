import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "./db.js";
import { createWorkerImpl, type WorkerDeps } from "./worker.js";
import type { TmuxController } from "./tmux.js";
import {
  createTestConfig,
  insertTestThread,
} from "./test-utils.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const tmpDir = join(import.meta.dir, "../.test-tmp-worker");

function createMockDeps(overrides?: {
  ensureSessionError?: Error;
  sendKeysError?: Error;
}): WorkerDeps & {
  mocks: {
    ensureSession: ReturnType<typeof mock>;
    sendKeys: ReturnType<typeof mock>;
    createWorktree: ReturnType<typeof mock>;
    removeWorktree: ReturnType<typeof mock>;
  };
} {
  const worktreePath = join(tmpDir, "mock-worktree");
  mkdirSync(worktreePath, { recursive: true });

  const ensureSession = mock(() => {
    if (overrides?.ensureSessionError) throw overrides.ensureSessionError;
    return Promise.resolve();
  });
  const sendKeys = mock(() => {
    if (overrides?.sendKeysError) throw overrides.sendKeysError;
    return Promise.resolve();
  });
  const createWorktreeMock = mock(
    (_repoPath: string, _branchName: string, _baseBranch: string) => worktreePath,
  );
  const removeWorktreeMock = mock(
    (_repoPath: string, _worktreePath: string) => {},
  );

  return {
    createWorktree: createWorktreeMock as unknown as typeof import("./worktree.js").createWorktree,
    removeWorktree: removeWorktreeMock as unknown as typeof import("./worktree.js").removeWorktree,
    tmuxFactory: (_session: string) =>
      ({
        ensureSession,
        sendKeys,
      }) as unknown as TmuxController,
    mocks: {
      ensureSession,
      sendKeys,
      createWorktree: createWorktreeMock,
      removeWorktree: removeWorktreeMock,
    },
  };
}

describe("createWorkerImpl", () => {
  let db: Database;
  const config = createTestConfig({ workDir: tmpDir });

  beforeEach(() => {
    db = initDatabase(":memory:");
    mkdirSync(tmpDir, { recursive: true });
    // Create a fake repo dir so resolveRepoPath works
    mkdirSync(join(tmpDir, "my-repo"), { recursive: true });
  });

  test("happy path — creates worktree, inserts DB row, sends command", async () => {
    const deps = createMockDeps();
    insertTestThread(db, { thread_id: "t1", session_name: "dispatch-t1" });

    const result = await createWorkerImpl(
      {
        thread_id: "t1",
        task_summary: "fix-auth-bug",
        prompt: "Fix the auth bug",
        repo_path: "my-repo",
        branch_base: "HEAD",
      },
      config,
      db,
      deps,
    );

    expect(result.window_name).toBe("fix-auth-bug");
    expect(result.worktree_path).toContain("mock-worktree");
    expect(result.progress_file).toContain(".dispatch-progress.json");

    // Verify DB row
    const win = db
      .query("SELECT * FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string; window_name: string; task_summary: string };
    expect(win.status).toBe("running");
    expect(win.window_name).toBe("fix-auth-bug");

    // Verify tmux calls
    expect(deps.mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(deps.mocks.sendKeys).toHaveBeenCalledTimes(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throws when thread not found", async () => {
    const deps = createMockDeps();

    await expect(
      createWorkerImpl(
        {
          thread_id: "nonexistent",
          task_summary: "test",
          prompt: "test",
          repo_path: "my-repo",
          branch_base: "HEAD",
        },
        config,
        db,
        deps,
      ),
    ).rejects.toThrow("Thread nonexistent not found");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("cleans up on tmux.ensureSession failure — marks window error, removes worktree", async () => {
    const deps = createMockDeps({
      ensureSessionError: new Error("tmux failed"),
    });
    insertTestThread(db, { thread_id: "t1", session_name: "dispatch-t1" });

    await expect(
      createWorkerImpl(
        {
          thread_id: "t1",
          task_summary: "fix-bug",
          prompt: "Fix the bug",
          repo_path: "my-repo",
          branch_base: "HEAD",
        },
        config,
        db,
        deps,
      ),
    ).rejects.toThrow("tmux failed");

    // Window should be marked as error
    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("error");

    // Worktree removal should have been attempted
    expect(deps.mocks.removeWorktree).toHaveBeenCalledTimes(1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("cleans up on tmux.sendKeys failure — marks window error", async () => {
    const deps = createMockDeps({
      sendKeysError: new Error("sendKeys failed"),
    });
    insertTestThread(db, { thread_id: "t1", session_name: "dispatch-t1" });

    await expect(
      createWorkerImpl(
        {
          thread_id: "t1",
          task_summary: "fix-bug",
          prompt: "Fix the bug",
          repo_path: "my-repo",
          branch_base: "HEAD",
        },
        config,
        db,
        deps,
      ),
    ).rejects.toThrow("sendKeys failed");

    const win = db
      .query("SELECT status FROM windows WHERE thread_id = ?")
      .get("t1") as { status: string };
    expect(win.status).toBe("error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("slugifies task_summary correctly", async () => {
    const deps = createMockDeps();
    insertTestThread(db, { thread_id: "t1", session_name: "dispatch-t1" });

    const result = await createWorkerImpl(
      {
        thread_id: "t1",
        task_summary: "Fix Auth Bug!!!",
        prompt: "Fix it",
        repo_path: "my-repo",
        branch_base: "HEAD",
      },
      config,
      db,
      deps,
    );

    expect(result.window_name).toBe("fix-auth-bug");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("truncates long task_summary to 30 chars", async () => {
    const deps = createMockDeps();
    insertTestThread(db, { thread_id: "t1", session_name: "dispatch-t1" });

    const result = await createWorkerImpl(
      {
        thread_id: "t1",
        task_summary: "this-is-a-very-long-task-summary-that-exceeds-thirty-characters",
        prompt: "Fix it",
        repo_path: "my-repo",
        branch_base: "HEAD",
      },
      config,
      db,
      deps,
    );

    expect(result.window_name.length).toBeLessThanOrEqual(30);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("duplicate worker for same thread creates second DB row", async () => {
    const deps = createMockDeps();
    insertTestThread(db, { thread_id: "t1", session_name: "dispatch-t1" });

    await createWorkerImpl(
      {
        thread_id: "t1",
        task_summary: "fix-bug",
        prompt: "First attempt",
        repo_path: "my-repo",
        branch_base: "HEAD",
      },
      config,
      db,
      deps,
    );

    await createWorkerImpl(
      {
        thread_id: "t1",
        task_summary: "fix-bug",
        prompt: "Second attempt",
        repo_path: "my-repo",
        branch_base: "HEAD",
      },
      config,
      db,
      deps,
    );

    // Both windows exist in DB
    const windows = db
      .query("SELECT * FROM windows WHERE thread_id = ?")
      .all("t1");
    expect(windows.length).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
