#!/usr/bin/env bash
# Called by the `promptctl-open` shell function (loaded from ~/.bashrc/.zshrc).
#
# Identifies the current Claude Code session by walking up the process tree
# from this shell's PID until it finds a process with a
# ~/.claude/projects/*/<sessionId>.jsonl file open — that's the Claude Code
# process writing this session's transcript. The session id is the filename.
# No mtime heuristic, no race.
#
# Then POSTs the deep-link URL to promptctl's local HTTP endpoint whose port
# is discovered from ~/.promptctl/deep-link-port (written by the app at
# startup).

set -euo pipefail

fail() { echo "promptctl-open: $1" >&2; exit 1; }

port_file="$HOME/.promptctl/deep-link-port"
[ -r "$port_file" ] || fail "promptctl not running (no $port_file)"
port=$(cat "$port_file")

# Walk the process tree up from our parent (the caller). Our own process is
# bash running the function body; its parent is the shell that sourced the
# function; eventually we reach the Claude Code process.
pid="${PPID:-$$}"
sid=""
steps=0
while [ "$pid" != "1" ] && [ "$pid" != "0" ] && [ "$steps" -lt 20 ]; do
  # lsof returns a non-zero exit when it has warnings. We only care about
  # whether any output matches our pattern.
  # `|| true` — grep exits non-zero on no-match; don't let that kill set -e.
  jsonl=$(lsof -p "$pid" -Fn 2>/dev/null | grep -oE "$HOME/\.claude/projects/[^[:space:]]+\.jsonl" | head -n 1 || true)
  if [ -n "$jsonl" ]; then
    sid=$(basename "$jsonl" .jsonl)
    break
  fi
  parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$parent" ] && break
  pid="$parent"
  steps=$((steps + 1))
done

[ -n "$sid" ] || fail "could not find Claude Code JSONL in ancestor processes"

url="promptctl://open?provider=claude&sessionId=$sid"
if curl -fsS --max-time 2 \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\"}" \
    "http://127.0.0.1:$port/open" >/dev/null; then
  echo "promptctl-open: opened session $sid"
else
  fail "HTTP POST to 127.0.0.1:$port/open failed"
fi
