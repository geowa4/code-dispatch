# Dispatch

Email-driven AI agent orchestrator. Dispatch polls an [AgentMail](https://agentmail.to) inbox for incoming tasks, breaks them into sub-tasks, and delegates each one to a Claude Code worker running in its own tmux window and git worktree.

## How it works

1. You send an email to a designated AgentMail inbox describing a coding task.
2. Dispatch picks it up on the next poll cycle.
3. An orchestrator agent (powered by the Claude Agent SDK) reads the email and decides how to split the work.
4. Each sub-task gets its own tmux window with an isolated git worktree and a dedicated Claude Code session.
5. Workers report progress via structured JSON files. Dispatch monitors them and replies to the email thread with updates.

## Prerequisites

- [Bun](https://bun.sh) (v1.1+)
- [tmux](https://github.com/tmux/tmux)
- [sqlite3](https://www.sqlite.org/) CLI
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`), authenticated via `claude auth login` or the `CLAUDE_CODE_OAUTH_TOKEN` env var
- An [AgentMail](https://agentmail.to) account and API key

## Setup

```bash
# Clone the repo
git clone <repo-url> && cd dispatch

# Install dependencies
bun install

# Set required environment variable
export AGENTMAIL_API_KEY="your-agentmail-api-key"
```

### Claude Code authentication

Dispatch launches Claude Code workers, so the CLI must be authenticated on the host. Either:

- Run `claude auth login` interactively, **or**
- Set `CLAUDE_CODE_OAUTH_TOKEN` in your environment.

> **Note:** Do _not_ set `ANTHROPIC_API_KEY` — it overrides Max plan billing.

## Usage

```bash
bun run start \
  --inbox <agentmail-inbox-address> \
  --allowed-domains <comma-separated-sender-domains> \
  --work-dir <path-to-repos>
```

### Required flags

| Flag | Description |
|---|---|
| `--inbox <address>` | AgentMail inbox address to poll |
| `--allowed-domains <list>` | Comma-separated list of sender domains to accept email from |
| `--work-dir <path>` | Root directory containing the git repos workers will operate on |

### Optional flags

| Flag | Default | Description |
|---|---|---|
| `--poll-interval <seconds>` | `300` | Seconds between poll cycles |
| `--db <path>` | `<work-dir>/dispatch.db` | Path to the SQLite database file |
| `--model <name>` | `claude-sonnet-4-6` | Claude model for the orchestrator agent |
| `--worker-model <name>` | `claude-sonnet-4-6` | Claude model for worker sessions |
| `--max-turns <n>` | `50` | Maximum turns per worker session |
| `--help` | | Show help and exit |

### Example

```bash
export AGENTMAIL_API_KEY="sk-am-..."

bun run start \
  --inbox dispatch@inbox.agentmail.to \
  --allowed-domains acme.com,example.org \
  --work-dir ~/projects \
  --poll-interval 60
```

This starts Dispatch polling every 60 seconds, accepting emails from `acme.com` and `example.org` senders, with repos located under `~/projects`.

## Development

```bash
bun run dev        # Run with --watch (auto-restart on file changes)
bun run typecheck  # Type-check without emitting (tsc --noEmit)
```

## Architecture

```
src/
├── main.ts          Entry point and poll loop
├── config.ts        CLI flag parsing and env validation
├── db.ts            SQLite schema and typed row interfaces
├── mail.ts          AgentMail client, inbox polling, reply helpers
├── orchestrator.ts  Claude Agent SDK orchestrator with MCP tools
├── tmux.ts          TmuxController for session/window management
├── worktree.ts      Git worktree create/remove/list
├── progress.ts      Worker progress file reader
└── completion.ts    Worker completion detection and reply cycle
```

Each email thread maps to a tmux session. Each sub-task becomes a tmux window with its own git worktree, so parallel workers never conflict on the filesystem. Workers write structured JSON progress files that the orchestrator reads to track status and compose replies.
