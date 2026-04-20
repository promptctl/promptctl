#!/usr/bin/env bash
# PostToolUse hook for Claude Code: opens the current session in promptctl.
#
# Trigger: a Bash tool call whose payload contains the literal __PROMPTCTL_OPEN__.
# Effect: tells the running promptctl to navigate to the current session.
#
# Transport preference:
#   1. Local HTTP (~/.promptctl/deep-link-port written by the app) — always
#      works, no LaunchServices involvement. Preferred in dev and prod.
#   2. Fallback: `open promptctl://...` — relies on macOS URL scheme dispatch.
#      Only works when promptctl is a packaged app with its own Info.plist.
#
# Install:
#   1. cp install/promptctl-open.sh ~/.claude/hooks/promptctl-open.sh
#   2. chmod +x ~/.claude/hooks/promptctl-open.sh
#   3. Register in ~/.claude/settings.json (see install/README.md).
#   4. Add the `promptctl-open` shell function (see install/README.md).

set -euo pipefail

# Match the marker anywhere in the payload. The user types `! promptctl-open`,
# so tool_input.command is just "promptctl-open" — the __PROMPTCTL_OPEN__
# marker arrives in tool_response (stdout of the function body). Scanning the
# whole payload avoids guessing Claude Code's exact response field name.
payload=$(cat)
case "$payload" in
  *__PROMPTCTL_OPEN__*) ;;
  *) exit 0 ;;
esac

sid=$(printf '%s' "$payload" | jq -r '.session_id // ""')
if [ -z "$sid" ]; then
  echo "promptctl-open: no session_id in hook payload" >&2
  exit 1
fi

url="promptctl://open?provider=claude&sessionId=$sid"
port_file="$HOME/.promptctl/deep-link-port"

if [ -r "$port_file" ]; then
  port=$(cat "$port_file")
  if curl -fsS --max-time 2 \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$url\"}" \
      "http://127.0.0.1:$port/open" >/dev/null; then
    exit 0
  fi
  echo "promptctl-open: http :$port/open failed, falling back to open(1)" >&2
fi

open "$url"
