# Dispatch

Email-driven AI agent orchestrator. Polls AgentMail inbox, delegates coding tasks to Claude Code workers in tmux sessions.

## Stack

- Runtime: Bun
- Language: TypeScript (strict mode)
- Database: SQLite via `bun:sqlite`
- Email: AgentMail SDK (`agentmail`)
- AI: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

## Commands

```bash
bun run start          # Run the daemon
bun run dev            # Run with --watch
bun run typecheck      # tsc --noEmit
```

## Architecture

- `src/main.ts` — Entry point, main poll loop
- `src/config.ts` — CLI flag parsing (node:util parseArgs), env validation
- `src/db.ts` — SQLite schema init and typed row interfaces
- `src/mail.ts` — AgentMail client, inbox polling, reply helpers
- `src/orchestrator.ts` — Claude Agent SDK orchestrator with MCP tools
- `src/tmux.ts` — TmuxController class for session/window management
- `src/worktree.ts` — Git worktree create/remove/list
- `src/progress.ts` — ProgressReport type and file reader
- `src/completion.ts` — Worker completion detection and reply cycle

## Key Design Decisions

- Single-threaded cooperative async. Parallelism comes from tmux workers.
- Each email thread maps to a tmux session. Each sub-task is a tmux window.
- Each window gets its own git worktree so parallel work doesn't conflict.
- Workers write structured JSON progress files; orchestrator reads them.
- No config files — all configuration via CLI flags and env vars.
