import { parseArgs } from "node:util";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Fatal: missing required environment variable ${name}`);
    process.exit(1);
  }
  return val;
}

function printUsage(): void {
  console.log(`dispatch [options]

Options:
  --inbox <address>          AgentMail inbox address (required)
  --allowed-domains <list>   Comma-separated sender domains (required)
  --work-dir <path>          Root directory for cloned repos (required)
  --poll-interval <seconds>  Seconds between poll cycles (default: 300)
  --db <path>                Path to SQLite database file (default: <work-dir>/dispatch.db)
  --model <name>             Claude model for the orchestrator agent (default: claude-sonnet-4-6)
  --worker-model <name>      Claude model for worker sessions (default: claude-sonnet-4-6)
  --max-turns <n>            Per-worker turn limit (default: 50)
  --help                     Show help and exit`);
}

export interface Config {
  readonly inbox: string;
  readonly allowedDomains: string[];
  readonly workDir: string;
  readonly pollInterval: number;
  readonly dbPath: string;
  readonly model: string;
  readonly workerModel: string;
  readonly maxTurns: number;
}

export function parseConfig(): Config {
  const { values: flags } = parseArgs({
    options: {
      inbox: { type: "string" },
      "allowed-domains": { type: "string" },
      "work-dir": { type: "string" },
      "poll-interval": { type: "string", default: "300" },
      db: { type: "string" },
      model: { type: "string", default: "claude-sonnet-4-6" },
      "worker-model": { type: "string", default: "claude-sonnet-4-6" },
      "max-turns": { type: "string", default: "50" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  if (!flags.inbox || !flags["allowed-domains"] || !flags["work-dir"]) {
    console.error(
      "Fatal: --inbox, --allowed-domains, and --work-dir are required",
    );
    process.exit(1);
  }

  return {
    inbox: flags.inbox,
    allowedDomains: flags["allowed-domains"]
      .split(",")
      .map((d) => d.trim().toLowerCase()),
    workDir: flags["work-dir"],
    pollInterval: parseInt(flags["poll-interval"]!, 10) * 1000,
    dbPath: flags.db ?? `${flags["work-dir"]}/dispatch.db`,
    model: flags.model!,
    workerModel: flags["worker-model"]!,
    maxTurns: parseInt(flags["max-turns"]!, 10),
  } as const;
}

export const AGENTMAIL_API_KEY = requireEnv("AGENTMAIL_API_KEY");
