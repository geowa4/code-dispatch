import type { Database } from "bun:sqlite";
import type { AgentMailClient } from "agentmail";
import type { Config } from "./config.js";
import type { WindowRow } from "./db.js";
import { getLastMessageId, replyToThread } from "./mail.js";
import { readProgress } from "./progress.js";
import { TmuxController } from "./tmux.js";

interface RunningWindowRow extends WindowRow {
  session_name: string;
}

export async function checkWorkerCompletion(
  db: Database,
  mail: AgentMailClient,
  config: Config,
): Promise<void> {
  const runningWindows = db
    .query(
      `SELECT w.*, t.session_name, t.thread_id
       FROM windows w
       JOIN threads t ON w.thread_id = t.thread_id
       WHERE w.status = 'running'`,
    )
    .all() as RunningWindowRow[];

  for (const win of runningWindows) {
    const tmux = new TmuxController(win.session_name);

    let idle: boolean;
    try {
      idle = await tmux.isIdle(win.window_name);
    } catch {
      // tmux session may have been killed externally
      db.run(
        "UPDATE windows SET status = 'error', finished_at = datetime('now') WHERE window_id = ?",
        [win.window_id],
      );
      continue;
    }

    if (!idle) continue;

    const progress = await readProgress(win.progress_file);
    if (!progress) continue;
    if (progress.status === "running") continue;

    const finalStatus = progress.status;
    const lastMsgId = getLastMessageId(db, win.thread_id);

    const replyBody =
      finalStatus === "done"
        ? `✅ Task complete: ${win.task_summary}\n\n` +
          `Branch: ${win.branch_name}\n` +
          `Worktree: ${win.worktree_path}\n\n` +
          `Summary:\n${progress.summary}\n\n` +
          `Steps completed:\n${progress.steps_completed.map((s: string) => `  • ${s}`).join("\n")}`
        : `❌ Task failed: ${win.task_summary}\n\n` +
          `Branch: ${win.branch_name}\n\n` +
          `Errors:\n${progress.errors.join("\n")}\n\n` +
          `Progress before failure:\n${progress.summary}`;

    const replyId = await replyToThread(
      mail,
      config.inbox,
      win.thread_id,
      lastMsgId,
      replyBody,
    );

    db.run(
      "UPDATE windows SET status = ?, finished_at = datetime('now'), last_reply_id = ? WHERE window_id = ?",
      [finalStatus, replyId, win.window_id],
    );

    const stillRunning = db
      .query(
        "SELECT COUNT(*) as cnt FROM windows WHERE thread_id = ? AND status = 'running'",
      )
      .get(win.thread_id) as { cnt: number };

    if (stillRunning.cnt === 0) {
      db.run(
        "UPDATE threads SET status = 'done', updated_at = datetime('now') WHERE thread_id = ?",
        [win.thread_id],
      );
    }
  }
}
