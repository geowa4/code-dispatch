import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.js";
import type { AgentMailClient } from "agentmail";
import type { ThreadRow } from "./db.js";
import type { MailThread, MailMessage } from "./mail.js";
import type { createOrchestratorTools } from "./tools.js";

export async function handleMessage(
  thread: MailThread,
  message: MailMessage,
  config: Config,
  db: Database,
  _mail: AgentMailClient,
  orchestratorTools: ReturnType<typeof createOrchestratorTools>,
): Promise<void> {
  let existingThread = db
    .query("SELECT * FROM threads WHERE thread_id = ?")
    .get(thread.threadId) as ThreadRow | null;

  if (!existingThread) {
    const sessionName = `dispatch-${thread.threadId.slice(0, 8)}`;
    db.run(
      `INSERT INTO threads (thread_id, inbox_id, subject, sender, session_name)
       VALUES (?, ?, ?, ?, ?)`,
      [thread.threadId, config.inbox, thread.subject ?? null, message.from, sessionName],
    );
    existingThread = db
      .query("SELECT * FROM threads WHERE thread_id = ?")
      .get(thread.threadId) as ThreadRow;
  }

  const threadContext =
    `Existing thread. Session: ${existingThread.session_name}. ` +
    `Status: ${existingThread.status}.`;

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
