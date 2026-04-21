# Open Claude Code session in promptctl (shell one-liner)

Inside Claude Code, type `! promptctl-open`. The current session opens in
promptctl's Context Workshop — no tokens spent, no session id to look up,
deterministic.

## How it works

The `!` prefix in Claude Code is a pure local shell passthrough: it bypasses
both `PostToolUse` and `UserPromptSubmit` hooks (confirmed empirically). So
the dispatch can't rely on hooks — it has to run entirely inside the shell
function.

1. `! promptctl-open` runs the shell function from your rc file.
2. The function calls `~/.claude/hooks/promptctl-open-dispatch.sh`.
3. That script walks up the process tree from itself until it finds a
   process with a `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` open
   (via `lsof -p`). That process is the Claude Code instance writing the
   current session's transcript; the filename IS the session id. No mtime
   heuristic, no race, no ambiguity.
4. The script reads `~/.promptctl/deep-link-port` (written by the running
   promptctl at startup), `curl`s
   `POST http://127.0.0.1:<port>/open` with the deep-link URL.
5. promptctl's HTTP handler calls `handleDeepLink`; the renderer's hash
   updates to `#/workshop?provider=claude&sessionId=...`;
   `useDeepLinkSelection` picks it up and loads the session.

## Install

### 1. Copy the dispatch script

```sh
mkdir -p ~/.claude/hooks
cp install/promptctl-open-dispatch.sh ~/.claude/hooks/promptctl-open-dispatch.sh
chmod +x ~/.claude/hooks/promptctl-open-dispatch.sh
```

(The script lives under `~/.claude/hooks/` by convention — it's not
registered as a hook; the directory is just a convenient home for
Claude-adjacent scripts.)

### 2. Add the shell function

In your shell rc (`~/.bashrc`, `~/.zshrc`, etc.):

```sh
promptctl-open() { ~/.claude/hooks/promptctl-open-dispatch.sh; }
```

Reload your shell (or `source` the rc file).

### 3. Launch promptctl

When promptctl starts, it writes its deep-link HTTP port to
`~/.promptctl/deep-link-port`. The dispatch script reads that file, so
promptctl must be running for `! promptctl-open` to work.

## Usage

Inside a Claude Code session:

```
! promptctl-open
```

The Context Workshop tab in promptctl switches to the current session.

## Troubleshooting

- **`promptctl not running`:** the port file `~/.promptctl/deep-link-port`
  is missing. Start promptctl (`npm start` in its repo, or launch the
  packaged app).
- **`could not find Claude Code JSONL in ancestor processes`:** the script
  walked 20 PPID levels without finding a Claude Code process with an open
  session JSONL. This would mean the dispatch is being invoked outside a
  Claude Code session — or `lsof` is blocked. Try `lsof -p $PPID` manually
  to confirm.
- **`HTTP POST failed`:** the port in `~/.promptctl/deep-link-port` is
  stale (app crashed without cleanup) or the port is blocked. Restart
  promptctl; it rewrites the port file at startup.
