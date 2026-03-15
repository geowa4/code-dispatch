import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.js";
import type { ThreadRow } from "./db.js";
import { TmuxController } from "./tmux.js";
import { createWorktree, resolveRepoPath } from "./worktree.js";

export interface CreateWorkerArgs {
  thread_id: string;
  task_summary: string;
  prompt: string;
  repo_path: string;
  branch_base: string;
}

export async function createWorkerImpl(
  args: CreateWorkerArgs,
  config: Config,
  db: Database,
): Promise<{
  window_name: string;
  worktree_path: string;
  progress_file: string;
}> {
  const repoPath = resolveRepoPath(config.workDir, args.repo_path);

  const threadRow = db
    .query("SELECT * FROM threads WHERE thread_id = ?")
    .get(args.thread_id) as ThreadRow | null;

  if (!threadRow) {
    throw new Error(`Thread ${args.thread_id} not found — it should be created before calling create_worker`);
  }

  const sessionName = threadRow.session_name;

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
  const promptFile = `/tmp/dispatch-prompt-${args.thread_id.slice(0, 8)}-${windowSlug}.txt`;
  writeFileSync(promptFile, fullPrompt, "utf-8");

  const resultFile = join(worktreePath, ".dispatch-result.json");

  const claudeCmd = [
    "claude",
    "--dangerously-skip-permissions",
    `-p "$(cat '${promptFile}')"`,
    `--model ${config.workerModel}`,
    `--max-turns ${config.maxTurns}`,
    "--output-format json",
    `> '${resultFile}' 2>&1`,
  ].join(" ");

  await tmux.sendKeys(windowSlug, claudeCmd);

  return {
    window_name: windowSlug,
    worktree_path: worktreePath,
    progress_file: progressFile,
  };
}
