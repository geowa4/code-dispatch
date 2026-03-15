import {
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.js";
import type { AgentMailClient } from "agentmail";
import type { ThreadRow } from "./db.js";
import { listRepos } from "./worktree.js";
import { readProgress } from "./progress.js";
import { replyToThread, getLastMessageId } from "./mail.js";
import { TmuxController } from "./tmux.js";
import { createWorkerImpl } from "./worker.js";

async function getAllStatusImpl(db: Database): Promise<object> {
  const activeThreads = db
    .query("SELECT * FROM threads WHERE status = 'active'")
    .all() as ThreadRow[];

  const report = [];

  for (const thread of activeThreads) {
    const windows = db
      .query("SELECT * FROM windows WHERE thread_id = ?")
      .all(thread.thread_id) as Array<{
      window_name: string;
      task_summary: string;
      status: string;
      progress_file: string;
    }>;

    const windowReports = [];
    for (const win of windows) {
      const progress = await readProgress(win.progress_file);
      const tmux = new TmuxController(thread.session_name);
      let paneState = "unknown";
      try {
        paneState = (await tmux.isIdle(win.window_name)) ? "idle" : "busy";
      } catch {
        /* session may have been killed externally */
      }

      windowReports.push({
        window: win.window_name,
        task: win.task_summary,
        db_status: win.status,
        pane_state: paneState,
        progress: progress ?? { status: "no progress file yet" },
      });
    }

    report.push({
      thread_id: thread.thread_id,
      subject: thread.subject,
      session: thread.session_name,
      status: thread.status,
      windows: windowReports,
    });
  }

  return { active_threads: report.length, threads: report };
}

const MAX_QUERY_ROWS = 1000;

export function createOrchestratorTools(
  config: Config,
  db: Database,
  mail: AgentMailClient,
) {
  const createWorkerTool = tool(
    "create_worker",
    "Create a new tmux window with a Claude Code worker for a sub-task. " +
      "Returns the window name and worktree path.",
    {
      thread_id: z
        .string()
        .describe("The email thread ID this worker belongs to"),
      task_summary: z
        .string()
        .describe("Short (3-5 word) name for the tmux window"),
      prompt: z
        .string()
        .describe("Full prompt to pass to claude -p in this window"),
      repo_path: z
        .string()
        .describe("Path to the git repo under work-dir"),
      branch_base: z
        .string()
        .describe("Base branch/commit to create the worktree from")
        .default("HEAD"),
    },
    async (args) => {
      const result = await createWorkerImpl(args, config, db);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  const getStatusTool = tool(
    "get_all_status",
    "Get the current status of all active worker sessions across all threads. " +
      "Reads each worker's progress file and tmux state.",
    {},
    async () => {
      const status = await getAllStatusImpl(db);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  const sendReplyTool = tool(
    "send_reply",
    "Send an email reply in a thread. Use for status updates or task completion notices.",
    {
      thread_id: z.string(),
      body: z.string().describe("Plain text body of the reply"),
    },
    async (args) => {
      const thread = db
        .query("SELECT * FROM threads WHERE thread_id = ?")
        .get(args.thread_id) as ThreadRow | null;
      if (!thread) {
        return {
          content: [{ type: "text" as const, text: "Error: thread not found" }],
        };
      }
      const lastMsgId = getLastMessageId(db, args.thread_id);
      const replyId = await replyToThread(
        mail,
        config.inbox,
        args.thread_id,
        lastMsgId,
        args.body,
      );
      return { content: [{ type: "text" as const, text: `Reply sent: ${replyId}` }] };
    },
  );

  const listReposTool = tool(
    "list_repos",
    "List all git repositories available under the work directory.",
    {},
    async () => {
      const repos = listRepos(config.workDir);
      return { content: [{ type: "text" as const, text: JSON.stringify(repos) }] };
    },
  );

  const queryDbTool = tool(
    "query_db",
    "Run a read-only SQL query against the Dispatch state database. " +
      "Use this to look up threads, windows, and their statuses. " +
      `Results are limited to ${MAX_QUERY_ROWS} rows.`,
    {
      sql: z.string().describe("SELECT query to run"),
    },
    async (args) => {
      const trimmed = args.sql.trim();
      if (!trimmed.toUpperCase().startsWith("SELECT")) {
        return {
          content: [
            { type: "text" as const, text: "Error: only SELECT queries allowed" },
          ],
        };
      }
      try {
        const limited = `SELECT * FROM (${trimmed}) LIMIT ${MAX_QUERY_ROWS}`;
        const rows = db.query(limited).all();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Query error: ${message}` }],
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "dispatch-tools",
    version: "1.0.0",
    tools: [
      createWorkerTool,
      getStatusTool,
      sendReplyTool,
      listReposTool,
      queryDbTool,
    ],
  });
}
