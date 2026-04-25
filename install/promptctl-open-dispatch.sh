#!/usr/bin/env bash
# Called by the `promptctl-open` shell function (from ~/.bashrc/.zshrc).
#
# Deterministic session-id resolution:
#   1. Walk PPIDs up from this script. At each step, check whether
#      `~/.claude/sessions/<pid>.json` exists. If so, that PID is a running
#      Claude Code process and the file contains {pid, sessionId, cwd, ...}.
#   2. Extract sessionId from that file.
#
# No mtime heuristic, no race, no reliance on the JSONL being created or
# flushed, no process-name matching (which differs between macOS and Linux —
# on macOS `comm` is the binary path, on Linux it's literally `claude`).
# The sessions registry file IS the signal.
#
# Then POSTs the deep-link URL to promptctl's HTTP endpoint whose port is
# discovered from ~/.promptctl/deep-link-port (written by the app at startup).

set -euo pipefail

fail() { echo "promptctl-open: $1" >&2; exit 1; }

port_file="$HOME/.promptctl/deep-link-port"
[ -r "$port_file" ] || fail "promptctl not running (no $port_file)"
port=$(cat "$port_file")

sessions_dir="$HOME/.claude/sessions"
[ -d "$sessions_dir" ] || fail "no $sessions_dir — claude never started?"

# 1. Walk PPIDs; first one with a matching session file wins.
pid="${PPID:-$$}"
session_file=""
steps=0
while [ "$pid" != "1" ] && [ "$pid" != "0" ] && [ "$steps" -lt 20 ]; do
  candidate="$sessions_dir/${pid}.json"
  if [ -r "$candidate" ]; then
    session_file="$candidate"
    break
  fi
  parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$parent" ] && break
  pid="$parent"
  steps=$((steps + 1))
done

[ -n "$session_file" ] || fail "no claude session registry found in PPID chain"

# 2. Extract sessionId (prefer jq, fall back to a plain regex).
if command -v jq >/dev/null 2>&1; then
  sid=$(jq -r '.sessionId // empty' "$session_file")
else
  sid=$(grep -oE '"sessionId":"[^"]+"' "$session_file" | head -1 | cut -d'"' -f4)
fi
[ -n "$sid" ] || fail "no sessionId in $session_file"

url="promptctl://open?provider=claude&sessionId=$sid"
if curl -fsS --max-time 2 \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\"}" \
    "http://127.0.0.1:$port/open" >/dev/null; then
  echo "promptctl-open: opened session $sid"
else
  fail "HTTP POST to 127.0.0.1:$port/open failed"
fi
