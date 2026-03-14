import { execSync } from "node:child_process";
import { checkWorkerCompletion } from "./completion.js";
import { AGENTMAIL_API_KEY, parseConfig } from "./config.js";
import { initDatabase } from "./db.js";
import { createMailClient, pollInbox } from "./mail.js";
import { createOrchestratorTools, handleMessage } from "./orchestrator.js";

const config = parseConfig();

async function main(): Promise<void> {
  console.log("Dispatch starting");
  console.log(`  Inbox:    ${config.inbox}`);
  console.log(`  Domains:  ${config.allowedDomains.join(", ")}`);
  console.log(`  Work dir: ${config.workDir}`);
  console.log(`  DB:       ${config.dbPath}`);
  console.log(`  Poll:     ${config.pollInterval / 1000}s`);

  const db = initDatabase(config.dbPath);
  const mail = createMailClient(AGENTMAIL_API_KEY);

  // Validate that required CLI tools are available
  try {
    execSync("tmux -V", { stdio: "pipe" });
  } catch {
    console.error("Fatal: tmux is not installed");
    process.exit(1);
  }
  try {
    execSync("sqlite3 --version", { stdio: "pipe" });
  } catch {
    console.error("Fatal: sqlite3 CLI is not installed");
    process.exit(1);
  }

  // Validate Claude Code CLI is installed and authenticated
  try {
    execSync("claude --version", { stdio: "pipe" });
  } catch {
    console.error(
      "Fatal: claude CLI is not installed (npm install -g @anthropic-ai/claude-code)",
    );
    process.exit(1);
  }
  try {
    execSync('claude -p "say ok" --output-format json --max-turns 1', {
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch {
    console.error(
      "Fatal: Claude authentication failed.\n" +
        "  Either run `claude auth login` on this host,\n" +
        "  or set CLAUDE_CODE_OAUTH_TOKEN.\n" +
        "  Do NOT set ANTHROPIC_API_KEY — it overrides Max plan billing.",
    );
    process.exit(1);
  }

  const orchestratorTools = createOrchestratorTools(config, db, mail);

  console.log("Dispatch running. Polling...");

  while (true) {
    try {
      await pollInbox(mail, config, db, (thread, message) =>
        handleMessage(thread, message, config, db, mail, orchestratorTools),
      );
      await checkWorkerCompletion(db, mail, config);
    } catch (err) {
      console.error("Poll cycle error:", err);
    }
    await Bun.sleep(config.pollInterval);
  }
}

main();
