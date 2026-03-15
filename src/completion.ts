import type { Database } from "bun:sqlite";
import type { AgentMailClient } from "agentmail";
import type { Config } from "./config.js";
import type { WindowRow } from "./db.js";
import { countWindowsByStatus } from "./db.js";
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
  createTmux: (session: string) => TmuxController = (s) =>
    new TmuxController(s),
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
    const tmux = createTmux(win.session_name);

    let idle: boolean;
    try {
      idle = await tmux.isIdle(win.window_name);
    } catch {
      // tmux session may have been killed externally — notify user
      try {
        const lastMsgId = getLastMessageId(db, win.thread_id);
        const errorBody =
          `❌ Task failed: ${win.task_summary}\n\n` +
          `Branch: ${win.branch_name}\n\n` +
          `The tmux session was terminated unexpectedly.`;
        await replyToThread(mail, config.inbox, win.thread_id, lastMsgId, errorBody);
      } catch {
        // best-effort reply; thread may not have messages yet
      }
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

    let replyId: string | null = null;
    try {
      replyId = await replyToThread(
        mail,
        config.inbox,
        win.thread_id,
        lastMsgId,
        replyBody,
      );
    } catch (err) {
      console.error(`Failed to send completion reply for window ${win.window_name}:`, err);
    }

    db.run(
      "UPDATE windows SET status = ?, finished_at = datetime('now'), last_reply_id = ? WHERE window_id = ?",
      [finalStatus, replyId, win.window_id],
    );

    if (countWindowsByStatus(db, win.thread_id, "running") === 0) {
      const hasErrors = countWindowsByStatus(db, win.thread_id, "error") > 0;
      const threadStatus = hasErrors ? "error" : "done";
      db.run(
        "UPDATE threads SET status = ?, updated_at = datetime('now') WHERE thread_id = ?",
        [threadStatus, win.thread_id],
      );
    }
  }

  // Safety net: detect stale threads that are "active" but have no running windows
  const staleThreads = db
    .query(
      `SELECT t.thread_id, t.session_name,
        (SELECT COUNT(*) FROM windows w WHERE w.thread_id = t.thread_id AND w.status = 'error') as error_count
       FROM threads t
       WHERE t.status = 'active'
         AND (SELECT COUNT(*) FROM windows w WHERE w.thread_id = t.thread_id) > 0
         AND (SELECT COUNT(*) FROM windows w WHERE w.thread_id = t.thread_id AND w.status = 'running') = 0`,
    )
    .all() as Array<{ thread_id: string; session_name: string; error_count: number }>;

  for (const stale of staleThreads) {
    const status = stale.error_count > 0 ? "error" : "done";
    console.error(`Stale thread ${stale.thread_id} detected — marking as ${status}`);
    db.run(
      "UPDATE threads SET status = ?, updated_at = datetime('now') WHERE thread_id = ?",
      [status, stale.thread_id],
    );
  }
}
