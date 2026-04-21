#!/usr/bin/env bash
# End-to-end test: real Claude Code in tmux + `! promptctl-open` + mock
# HTTP endpoint. Pass iff the mock server captures a POST whose sessionId
# matches a real JSONL written by the actual claude binary.

set -u

CAPTURED=/tmp/captured.jsonl
SERVER_LOG=/tmp/mock-server.log
TMUX_LOG=/tmp/tmux-pane.log
CLAUDE_JSONL_DIR="$HOME/.claude/projects/-workspace"

step() { echo; echo "==> $*"; }

# ---------------------------------------------------------------------------
step "0. Dependency + version check"
which claude && claude --version 2>&1 | head -5 || true
tmux -V
lsof -v 2>&1 | head -1 || true

# ---------------------------------------------------------------------------
step "1. Start mock promptctl HTTP server"
python3 /workspace/mock-promptctl-server.py >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  [ -s "$HOME/.promptctl/deep-link-port" ] && break
  sleep 0.1
done
if [ ! -s "$HOME/.promptctl/deep-link-port" ]; then
  echo "FAIL: mock server did not write port file"; cat "$SERVER_LOG"; exit 1
fi
PORT=$(cat "$HOME/.promptctl/deep-link-port")
echo "mock server PID=$SERVER_PID, port=$PORT"

# ---------------------------------------------------------------------------
step "2. Start a plain bash shell in tmux, then send the claude command"
# Starting tmux with a default shell (no -c "cmd") and then `send-keys`-ing
# the claude invocation makes claude inherit the pane's PTY on stdin/stdout.
# Passing the cmd to new-session directly caused claude to see non-TTY and
# bail out in --print mode with "Input must be provided...".
mkdir -p "$CLAUDE_JSONL_DIR"
tmux new-session -d -s test -x 220 -y 60 bash
tmux pipe-pane -t test -o "cat >/tmp/claude-in-tmux.log"
sleep 0.5
tmux send-keys -t test "cd /workspace" Enter
sleep 0.3
tmux send-keys -t test "claude --dangerously-skip-permissions" Enter

# Drive past whatever onboarding prompts appear. Claude's prompts all share
# the shape `Enter to confirm` with a highlighted default — just send Enter
# every second until either the JSONL appears (claude reached main prompt) or
# we time out. Idempotent: extra Enters at the main prompt are harmless.
step "3. Drive past onboarding — fire Enter until the main REPL prompt appears"
# Spam Enter for up to 30s; onboarding prompts all have an Enter-to-confirm
# default. Extra Enters at the main prompt are harmless (they submit empty
# prompts which claude ignores).
for i in $(seq 1 30); do
  sleep 1
  tmux send-keys -t test Enter 2>/dev/null || true
  # Detect the main prompt marker in the pane dump.
  if tmux capture-pane -t test -p | grep -q "bypass permissions on"; then
    echo "main prompt reached after ${i}s"
    break
  fi
done
echo "--- pane dump ---"
tmux capture-pane -t test -p | head -40

# ---------------------------------------------------------------------------
step "4. Send '! promptctl-open' to Claude Code"
# Clear any pending input first (Ctrl-U).
tmux send-keys -t test C-u
sleep 0.3
tmux send-keys -t test "! promptctl-open" Enter

# Wait up to 20s for POST to land.
for i in $(seq 1 200); do
  [ -s "$CAPTURED" ] && break
  sleep 0.1
done

# ---------------------------------------------------------------------------
step "5. Process tree after dispatch"
ps -ef | grep -E "tmux|claude|node|bash|python|dispatch" | grep -v grep

# ---------------------------------------------------------------------------
step "6. Post-dispatch pane"
tmux capture-pane -t test -p | tee "$TMUX_LOG" | tail -40

step "7. Results"
echo "--- captured.jsonl ---"
cat "$CAPTURED" 2>/dev/null || echo "(empty)"
echo "--- mock-server.log ---"
cat "$SERVER_LOG"
echo "--- JSONL files on disk ---"
ls -la "$CLAUDE_JSONL_DIR" 2>&1

# ---------------------------------------------------------------------------
step "8. Verdict"
RESULT=fail
REASON=""
if [ ! -s "$CAPTURED" ]; then
  REASON="mock server never received a POST"
else
  CAPTURED_SID=$(grep -oE 'sessionId=[a-zA-Z0-9-]+' "$CAPTURED" | head -1 | cut -d= -f2)
  if [ -z "$CAPTURED_SID" ]; then
    REASON="POST arrived but no sessionId found"
  elif [ ! -f "$CLAUDE_JSONL_DIR/$CAPTURED_SID.jsonl" ]; then
    REASON="captured sessionId=$CAPTURED_SID has no matching JSONL on disk"
  else
    RESULT=pass
  fi
fi

tmux kill-server 2>/dev/null || true
kill "$SERVER_PID" 2>/dev/null || true

echo
if [ "$RESULT" = "pass" ]; then
  echo "RESULT: PASS — real Claude Code -> '! promptctl-open' -> HTTP POST matched a real JSONL."
  echo "        sessionId = $CAPTURED_SID"
  exit 0
else
  echo "RESULT: FAIL ($REASON)"
  exit 1
fi
