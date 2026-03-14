import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.js";
import type { AgentMailClient } from "agentmail";
import { TmuxController } from "./tmux.js";
import { createWorktree, listRepos } from "./worktree.js";
import { readProgress } from "./progress.js";
import { replyToThread, getLastMessageId } from "./mail.js";
import type { MailThread, MailMessage } from "./mail.js";
import type { ThreadRow } from "./db.js";

interface CreateWorkerArgs {
  thread_id: string;
  task_summary: string;
  prompt: string;
  repo_path: string;
  branch_base: string;
}

async function createWorkerImpl(
  args: CreateWorkerArgs,
  config: Config,
  db: Database,
): Promise<{
  window_name: string;
  worktree_path: string;
  progress_file: string;
}> {
  const repoPath = join(config.workDir, args.repo_path);

  const threadRow = db
    .query("SELECT * FROM threads WHERE thread_id = ?")
    .get(args.thread_id) as ThreadRow | null;

  const sessionName =
    threadRow?.session_name ?? `dispatch-${args.thread_id.slice(0, 8)}`;

  if (!threadRow) {
    db.run(
      `INSERT INTO threads (thread_id, inbox_id, sender, repo_path, session_name)
       VALUES (?, ?, ?, ?, ?)`,
      [args.thread_id, config.inbox, "pending", repoPath, sessionName],
    );
  }

  const windowSlug = args.task_summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const branchName = `dispatch/${sessionName}/${windowSlug}`;
  const worktreePath = createWorktree(repoPath, branchName, args.branch_base);

  const progressFile = join(worktreePath, ".dispatch-progress.json");

  db.run(
    `INSERT INTO windows
       (thread_id, window_name, worktree_path, branch_name, progress_file, task_summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      args.thread_id,
      windowSlug,
      worktreePath,
      branchName,
      progressFile,
      args.task_summary,
    ],
  );

  const tmux = new TmuxController(sessionName);
  await tmux.ensureSession(windowSlug, worktreePath);

  const progressInstruction = `

IMPORTANT: You MUST periodically write progress updates to the file:
  ${progressFile}

Write this file as JSON with the following structure:
{
  "status": "running" | "done" | "error",
  "percent_complete": <0-100>,
  "current_step": "<what you are doing right now>",
  "steps_completed": ["<step 1>", "<step 2>", ...],
  "errors": ["<error if any>"],
  "summary": "<overall summary of progress so far>",
  "updated_at": "<ISO 8601 timestamp>"
}

Update this file after completing each meaningful step. When you are finished
with the entire task, set status to "done" and percent_complete to 100.
If you encounter an unrecoverable error, set status to "error".

If any bash commands will take a long time (more than ~30 seconds), run them
in the background or mention that they are long-running in your progress file
before starting them.`;

  const fullPrompt = args.prompt + progressInstruction;
  const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");

  const claudeCmd = [
    "claude",
    "--dangerously-skip-permissions",
    `-p '${escapedPrompt}'`,
    `--model ${config.workerModel}`,
    `--max-turns ${config.maxTurns}`,
    "--output-format json",
    `> /tmp/dispatch-result-${windowSlug}.json 2>&1`,
  ].join(" ");

  await tmux.sendKeys(windowSlug, claudeCmd);

  return {
    window_name: windowSlug,
    worktree_path: worktreePath,
    progress_file: progressFile,
  };
}

function buildWorkerSystemSuffix(
  progressFile: string,
  taskSummary: string,
): string {
  return `
You are a worker agent managed by Dispatch. Your task: ${taskSummary}

Progress reporting:
- Write structured JSON progress to: ${progressFile}
- Update after every meaningful step
- Set status to "done" when finished, "error" if stuck

Long-running commands:
- If a bash command will take more than ~30 seconds, note this in your
  progress file before running it
- Prefer running long commands with output redirected to a log file so
  you can continue working on other parts of the task

Git workflow:
- You are in a dedicated worktree on a dedicated branch
- Commit frequently with descriptive messages
- Do not push unless explicitly asked to in the task description
`;
}

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
      "Use this to look up threads, windows, and their statuses.",
    {
      sql: z.string().describe("SELECT query to run"),
    },
    async (args) => {
      if (!args.sql.trim().toUpperCase().startsWith("SELECT")) {
        return {
          content: [
            { type: "text" as const, text: "Error: only SELECT queries allowed" },
          ],
        };
      }
      const rows = db.query(args.sql).all();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      };
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

export async function handleMessage(
  thread: MailThread,
  message: MailMessage,
  config: Config,
  db: Database,
  mail: AgentMailClient,
  orchestratorTools: ReturnType<typeof createOrchestratorTools>,
): Promise<void> {
  const existingThread = db
    .query("SELECT * FROM threads WHERE thread_id = ?")
    .get(thread.threadId) as ThreadRow | null;

  const threadContext = existingThread
    ? `Existing thread. Session: ${existingThread.session_name}. ` +
      `Status: ${existingThread.status}.`
    : "New thread — no session exists yet.";

  const systemPrompt = `You are Dispatch, an AI agent orchestrator. You manage a team of
Claude Code workers running in tmux sessions. You receive tasks via email and delegate
them to workers.

Current state:
- Inbox: ${config.inbox}
- Work directory: ${config.workDir}
- ${threadContext}

Rules:
- For new coding tasks: create one or more workers using create_worker.
  Each worker runs in its own tmux window within the thread's session.
  If the task has clearly separable sub-parts, use multiple windows.
  If it's a single coherent task, use one window.
- For status requests: use get_all_status, then send_reply with a summary.
- For cancellations: note them but do not kill running workers (the operator
  can do that manually). Update the thread status via query_db is read-only,
  so just acknowledge.
- Window names must be short (2-4 words, kebab-case) and relevant.
- Each worker prompt MUST include an instruction to write progress updates
  to the progress file path you'll receive back from create_worker.
- Worker prompts should be self-contained — include all relevant context
  from the email thread.`;

  const userMessage = `From: ${message.from}
Subject: ${thread.subject}
Thread ID: ${thread.threadId}

${message.extractedText || message.text}`;

  for await (const event of query({
    prompt: userMessage,
    options: {
      systemPrompt,
      model: config.model,
      mcpServers: { "dispatch-tools": orchestratorTools },
      allowedTools: [],
      maxTurns: 20,
    },
  })) {
    if (event.type === "result" && event.subtype !== "success") {
      console.error("Orchestrator error:", event);
    }
  }
}

export { buildWorkerSystemSuffix };
