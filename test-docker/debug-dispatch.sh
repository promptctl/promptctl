#!/usr/bin/env bash
# Drop-in replacement for the dispatch script that prints diagnostics instead
# of just a failure message. For test-harness use only.

set -u

LOG=/tmp/dispatch-debug.log
exec 9>"$LOG"
echo "=== dispatch-debug $(date +%H:%M:%S) ===" >&9
echo "my pid=$$ ppid=${PPID:-?} cwd=$PWD" >&9
echo >&9

port_file="$HOME/.promptctl/deep-link-port"
if [ ! -r "$port_file" ]; then
  echo "FAIL: no port file $port_file" >&9
  echo "promptctl-open: no port file" >&2
  exit 1
fi
port=$(cat "$port_file")
echo "port file: $port_file ($port)" >&9

echo >&9
echo "=== full ps -ef ===" >&9
ps -ef >&9
echo >&9

pid="${PPID:-$$}"
steps=0
sid=""
while [ "$pid" != "1" ] && [ "$pid" != "0" ] && [ "$steps" -lt 20 ]; do
  echo "--- step $steps pid=$pid ---" >&9
  ps -o pid,ppid,cmd -p "$pid" 2>&1 >&9
  echo "  lsof -p $pid output:" >&9
  lsof -p "$pid" 2>&1 | head -50 >&9
  echo "  matches:" >&9
  lsof -p "$pid" -Fn 2>/dev/null | grep -E "\.claude|\.jsonl" >&9 || echo "  (no claude/jsonl matches)" >&9

  jsonl=$(lsof -p "$pid" -Fn 2>/dev/null | grep -oE "$HOME/\.claude/projects/[^[:space:]]+\.jsonl" | head -n 1 || true)
  if [ -n "$jsonl" ]; then
    sid=$(basename "$jsonl" .jsonl)
    echo "FOUND jsonl=$jsonl sid=$sid" >&9
    break
  fi
  parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$parent" ] && break
  pid="$parent"
  steps=$((steps + 1))
done

echo >&9
echo "=== final sid=${sid:-<none>} ===" >&9

if [ -z "$sid" ]; then
  echo "promptctl-open: could not find Claude Code JSONL in ancestor processes (see $LOG)" >&2
  exit 1
fi

url="promptctl://open?provider=claude&sessionId=$sid"
if curl -fsS --max-time 2 \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\"}" \
    "http://127.0.0.1:$port/open" >/dev/null; then
  echo "promptctl-open: opened session $sid"
else
  echo "promptctl-open: HTTP POST failed" >&2
  exit 1
fi
