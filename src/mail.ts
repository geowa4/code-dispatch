import { AgentMailClient } from "agentmail";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.js";

export function createMailClient(apiKey: string): AgentMailClient {
  return new AgentMailClient({ apiKey });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function replyToThread(
  mail: AgentMailClient,
  inboxId: string,
  threadId: string,
  lastMessageId: string,
  body: string,
): Promise<string> {
  const reply = await mail.inboxes.messages.reply(inboxId, lastMessageId, {
    text: body,
    html: `<pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(body)}</pre>`,
  });

  await mail.inboxes.messages.update(inboxId, lastMessageId, {
    addLabels: ["replied"],
    removeLabels: ["unreplied"],
  });

  return reply.messageId;
}

export function getLastMessageId(db: Database, threadId: string): string {
  const row = db
    .query(
      `SELECT message_id FROM messages_seen
       WHERE thread_id = ?
       ORDER BY seen_at DESC LIMIT 1`,
    )
    .get(threadId) as { message_id: string } | null;
  if (!row) {
    throw new Error(`No messages found for thread ${threadId}`);
  }
  return row.message_id;
}

export interface MailThread {
  threadId: string;
  subject?: string;
}

export interface MailMessage {
  messageId: string;
  from: string;
  text?: string;
  extractedText?: string;
  extractedHtml?: string;
}

export async function pollInbox(
  mail: AgentMailClient,
  config: Config,
  db: Database,
  handleMessage: (thread: MailThread, message: MailMessage) => Promise<void>,
): Promise<void> {
  const response = await mail.inboxes.threads.list(config.inbox, {
    labels: ["unreplied"],
  });

  const threads = response.threads ?? [];

  for (const threadItem of threads) {
    // Fetch the full thread to get messages
    const thread = await mail.inboxes.threads.get(config.inbox, threadItem.threadId);
    const messages = thread.messages ?? [];
    if (messages.length === 0) continue;

    // Process all unseen messages in the thread (not just the last)
    for (const msg of messages) {
      const senderDomain = msg.from?.split("@")[1]?.toLowerCase();
      if (!senderDomain || !config.allowedDomains.includes(senderDomain)) {
        continue;
      }

      const seen = db
        .query("SELECT 1 FROM messages_seen WHERE message_id = ?")
        .get(msg.messageId);
      if (seen) continue;

      await handleMessage(
        { threadId: thread.threadId, subject: thread.subject },
        {
          messageId: msg.messageId,
          from: msg.from,
          text: msg.text,
          extractedText: msg.extractedText,
          extractedHtml: msg.extractedHtml,
        },
      );

      // Insert after handleMessage so the thread row exists (FK constraint)
      db.run(
        "INSERT INTO messages_seen (message_id, thread_id) VALUES (?, ?)",
        [msg.messageId, thread.threadId],
      );
    }
  }
}
