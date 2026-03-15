import { execFileSync } from "node:child_process";

export function validateEnvironment(): void {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
  } catch {
    console.error("Fatal: tmux is not installed");
    process.exit(1);
  }

  try {
    execFileSync("sqlite3", ["--version"], { stdio: "pipe" });
  } catch {
    console.error("Fatal: sqlite3 CLI is not installed");
    process.exit(1);
  }

  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
  } catch {
    console.error(
      "Fatal: claude CLI is not installed (npm install -g @anthropic-ai/claude-code)",
    );
    process.exit(1);
  }

  try {
    execFileSync(
      "claude",
      ["-p", "say ok", "--output-format", "json", "--max-turns", "1"],
      { stdio: "pipe", timeout: 30_000 },
    );
  } catch {
    console.error(
      "Fatal: Claude authentication failed.\n" +
        "  Either run `claude auth login` on this host,\n" +
        "  or set CLAUDE_CODE_OAUTH_TOKEN.\n" +
        "  Do NOT set ANTHROPIC_API_KEY — it overrides Max plan billing.",
    );
    process.exit(1);
  }
}
