import { checkWorkerCompletion } from "./completion.js";
import { AGENTMAIL_API_KEY, parseConfig } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { initDatabase } from "./db.js";
import { createMailClient, pollInbox } from "./mail.js";
import { handleMessage } from "./orchestrator.js";
import { validateEnvironment } from "./startup.js";
import { createOrchestratorTools } from "./tools.js";

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

  validateEnvironment();

  startDashboard(config.dashboardPort, db);
  console.log(`  Dashboard: http://localhost:${config.dashboardPort}`);

  const orchestratorTools = createOrchestratorTools(config, db, mail);

  process.on("SIGINT", () => {
    console.log("Shutting down...");
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    console.log("Shutting down...");
    db.close();
    process.exit(0);
  });

  console.log("Dispatch running. Polling...");

  let consecutiveErrors = 0;
  while (true) {
    try {
      await pollInbox(mail, config, db, (thread, message) =>
        handleMessage(thread, message, config, db, mail, orchestratorTools),
      );
      await checkWorkerCompletion(db, mail, config);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error("Poll cycle error:", err);
      if (consecutiveErrors > 1) {
        const backoff = Math.min(
          config.pollInterval * 2 ** (consecutiveErrors - 1),
          300_000,
        );
        console.error(
          `Backing off for ${backoff / 1000}s after ${consecutiveErrors} consecutive errors`,
        );
        await Bun.sleep(backoff);
        continue;
      }
    }
    await Bun.sleep(config.pollInterval);
  }
}

main();
