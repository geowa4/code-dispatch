import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.js";
import type { AgentMailClient } from "agentmail";
import { getThread } from "./db.js";
import type { MailThread, MailMessage } from "./mail.js";
import { replyToThread, getLastMessageId } from "./mail.js";
import type { createOrchestratorTools } from "./tools.js";

export async function handleMessage(
  thread: MailThread,
  message: MailMessage,
  config: Config,
  db: Database,
  mail: AgentMailClient,
  orchestratorTools: ReturnType<typeof createOrchestratorTools>,
): Promise<void> {
  let existingThread = getThread(db, thread.threadId);

  if (!existingThread) {
    const sessionName = `dispatch-${thread.threadId.slice(0, 8)}`;
    db.run(
      `INSERT INTO threads (thread_id, inbox_id, subject, sender, session_name)
       VALUES (?, ?, ?, ?, ?)`,
      [thread.threadId, config.inbox, thread.subject ?? null, message.from, sessionName],
    );
    existingThread = getThread(db, thread.threadId)!;
  }

  const threadContext =
    `Existing thread. Session: ${existingThread.session_name}. ` +
    `Status: ${existingThread.status}.`;

  const systemPrompt = `You are Dispatch, an AI agent orchestrator. You manage Claude Code workers running in tmux sessions. You receive tasks via email and delegate them to workers.

Current state:
- Inbox: ${config.inbox}
- Work directory: ${config.workDir}
- ${threadContext}

Guidelines:
- Break complex tasks into independent sub-tasks and assign each to a separate worker via create_worker.
- For simple or tightly coupled tasks, use a single worker.
- Always include full context in the worker prompt — workers cannot see the email thread.
- After creating workers or checking status, always send_reply so the user gets an email response.
- When a follow-up message arrives on an existing thread, check current worker status before creating new workers.
- If a task references a specific repo, use list_repos to verify it exists before creating workers.
- If something goes wrong, send_reply with a clear explanation rather than silently failing.`;

  const userMessage = `From: ${message.from}
Subject: ${thread.subject}
Thread ID: ${thread.threadId}

${message.extractedText || message.text}`;

  try {
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
  } catch (err) {
    console.error("Orchestrator crashed:", err);
    try {
      const lastMsgId = getLastMessageId(db, thread.threadId);
      await replyToThread(
        mail,
        config.inbox,
        thread.threadId,
        lastMsgId,
        "Internal error processing your request. Please try again or reply to this thread.",
      );
    } catch {
      /* best-effort reply */
    }
  }
}
