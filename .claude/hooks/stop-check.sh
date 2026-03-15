#!/bin/bash

# Stop hook: prevent Claude from stopping when checks fail.
# Exit 0 = allow stop, Exit 2 = block stop and keep working.

INPUT=$(cat)

# Prevent infinite loops — if we already blocked once, let Claude stop.
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0
fi

if ! bun run typecheck 2>&1; then
  echo "Type checking failed. Fix type errors before stopping." >&2
  exit 2
fi

if ! bun run lint 2>&1; then
  echo "Linting failed. Fix lint errors before stopping." >&2
  exit 2
fi

exit 0
