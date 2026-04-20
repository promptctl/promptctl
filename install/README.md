# Open Claude Code session in promptctl (shell one-liner)

Inside Claude Code, type `! promptctl-open`. The currently running session
opens in promptctl's Context Workshop — no tokens spent, no session id to
look up.

## How it works

1. `! promptctl-open` runs a trivial shell function that prints the literal
   marker `__PROMPTCTL_OPEN__`.
2. Claude Code fires a `PostToolUse` hook with a JSON payload on stdin that
   includes `session_id` and the Bash tool input (the command text with the
   marker).
3. The hook matches the marker, extracts `session_id`, and runs
   `open promptctl://open?provider=claude&sessionId=<id>`.
4. promptctl receives the URL (via the `promptctl://` protocol registered on
   launch), navigates to `/workshop`, resolves the session id to its file,
   and loads it.

No race, no filesystem heuristic, no token cost.

## Install

### 1. Copy the hook script

```sh
mkdir -p ~/.claude/hooks
cp install/promptctl-open.sh ~/.claude/hooks/promptctl-open.sh
chmod +x ~/.claude/hooks/promptctl-open.sh
```

### 2. Register the hook in `~/.claude/settings.json`

Merge this into your existing `hooks` block:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/YOU/.claude/hooks/promptctl-open.sh"
          }
        ]
      }
    ]
  }
}
```

(Replace `/Users/YOU` with `$HOME` — the file needs an absolute path.)

### 3. Add the shell function

In your shell rc (`~/.zshrc`, `~/.bashrc`, etc.):

```sh
promptctl-open() {
  echo "__PROMPTCTL_OPEN__ — opening in promptctl"
}
```

Reload your shell (or `source` the rc file).

### 4. Launch promptctl once

The app registers `promptctl://` as a default protocol client the first time
it runs under macOS / your DE. After that, `open promptctl://...` from any
shell will hand the URL to the running instance (or launch one).

## Usage

Inside a Claude Code session:

```
! promptctl-open
```

The Context Workshop tab opens with the current session loaded.

## Troubleshooting

- **Nothing happens:** verify the hook ran — `~/.claude/logs/` and the
  script's own stderr (the hook prints to stderr when `session_id` is
  missing). You can also drop `echo "hook fired: $cmd" >&2` near the top
  of the script while debugging.
- **URL didn't dispatch:** test the URL directly — `open
  "promptctl://open?provider=claude&sessionId=<real-session-uuid>"`. If the
  app opens but the session doesn't load, `session:find` in the main
  process couldn't locate the file; check that
  `~/.claude/projects/<encoded-cwd>/<id>.jsonl` exists.
- **Wrong session:** the hook uses the `session_id` Claude Code puts in
  the payload — that's the authoritative current session. If it's wrong,
  Claude Code itself is confused (rare; restart).
