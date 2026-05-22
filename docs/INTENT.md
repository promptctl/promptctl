# promptctl — product intent

This document captures what promptctl is *for* and the open workstreams
that move it toward that. It is the planning artifact; `lit` carries the
actual tickets. Read this first when picking up work.

When this doc and a ticket disagree, this doc wins — update the ticket.

---

## What promptctl is

A desktop app for orchestrating local AI coding tools (Claude Code, Codex,
Gemini, etc.) on the developer's own machine. It treats them as
controllable processes rather than interactive-only terminals.

It does this through four working surfaces today, plus a fifth that is
the unifying view the others build toward.

### Loops — the tmux control plane

Browse every tmux pane on the machine. Select one, see the live terminal,
type into it. Schedule commands against panes ("every 5 min, send `status`
to %17"). Browse a library of markdown prompts checked into the repo.

This surface lives entirely on tmux. No tmux, not supported.

### Context Workshop — the session-file editor

Open old AI-coding conversations (`.jsonl` for Claude, `.json` for Gemini).
Trim and transform them so a new session can be seeded cheaply from the
essential context. Supports multiple operations: strip thinking blocks,
summarize/truncate tool results, smart-compress via an LLM, topic-focus.
Saves are versioned and structurally validated.

### Live — the request inspector

Watch every request flowing through the local proxy to `api.anthropic.com`
(and eventually other providers). Requests are first-class entities
grouped by the client/launch that issued them. Drill in to see structured
content blocks (text / tool_use / tool_result / thinking), token usage,
cache hit rates, conversation lineage across a chain.

### Settings — global config

OpenAI key + model for cheap-model analysis paths. Compression thresholds.
Proxy config. Stored at `~/.promptctl/settings.json`.

### Workshop — the unifying surface (planned, doesn't exist yet)

The fifth top-tab. Spawn a tagged tool launch from here. Watch the pane,
the requests, and the session file the tool is writing — all in one view.
"Open pane" / "Open requests" / "Open session" links across to the other
tabs. The only place that creates launches; Loops can attach to panes
but not spawn tagged launches.

---

## The cross-cutting spine: launch identity

The thing missing today that ties everything together: when promptctl
spawns a tool, it stamps that launch with an opaque `launchId` that
flows through three channels:

1. **Env var** in the spawned process — recoverable from `/proc/<pid>/environ`
   or `ps -E` after a promptctl restart.
2. **HTTP header** (`X-Promptctl-Launch`) on every proxy request the tool
   makes — gives the Live tab O(1) attribution with no socket→pid guessing.
3. **Tmux pane subscription** on `pane_current_command` — confirms the
   launch ran in the pane we expected.

A `LaunchRegistry` (main-process, persisted to disk) owns these rows.
Every tab projects from it. This is what makes "this pane / this request /
this session file all belong to the same thing" true at the type level
rather than at the heuristic-guessing level.

The existing proxy `client-identity.ts` walk stays as a fallback for
traffic from tools we *didn't* launch (a stray `claude` someone ran by hand).

---

## State of the world right now (what's done)

- **Live tab structured views** — request grouping, client identity,
  per-request detail pane, token/cache badges, conversation threading
  + diff view, stop-reason chip, latency sparklines, block-renderer
  registry. Most of `ac1.*` foundation is shipped.
- **Tmux control-mode foundation** — singleton `TmuxControlConnection`,
  topology tracker, output router, named-session ownership, xterm.js
  rendering on the `/debug/tmux-control` route. All of `77e.1.1`–`77e.1.5` +
  `77e.1.8` shipped.
- **The `@promptctl/pane-terminal` library package** in
  `~/code/tmux-control-mode-js/packages/pane-terminal/` — extracted,
  optimized, has Stream/Sink split, in-place setters, cached-seed
  re-attach. Promptctl does not consume it yet.
- **Context Workshop core** — session loading, editing, validation, save
  versioning, the per-operation transforms (Auto-Trim, Compress Tools,
  Smart Compress, Topic Focus). All work, but each is a separate code
  path with a separate save flow.

---

## Open workstreams

Each workstream is one to three tickets in `lit`. Order below is the
intended sequence — earlier workstreams unblock later ones.

### A. Tmux foundation cleanup *(shipped — 77e.1.9)*

**Outcome:** Loops runs on the new control-mode path. The legacy polling
tmux stack and the throwaway in-repo `PaneTerminal` are deleted. Loops
consumes the `@promptctl/pane-terminal` library package — same rendering
substrate as any other consumer of `tmux-control-mode-js`. CommandEngine
drives matchers / actions through a three-method seam wired to the
singleton `TmuxControlConnection`. The `/debug/tmux-control` route remains
as the permanent diagnostic surface.

### B. Loops polish

**Outcome:** Loops feels like a real terminal multiplexer. `C-b`-prefixed
keys work (split, kill, zoom, resize) via the library's keymap engine.
Per-pane header shows tool badge, cwd, process tree at a glance. Composer
is fast and natural.

### C. Launch registry — the spine

**Outcome:** Every tool spawn from promptctl carries an opaque `launchId`
that is recoverable from env, header, and tmux state. A persisted
`LaunchRegistry` is the single owner of these rows. Launches survive a
promptctl restart (env scan re-binds running tools). Exit is detected via
subscription, not polling.

Unblocks: D, E, G.

### D. Live tab — launch-aware identity

**Outcome:** The proxy attributes requests by `X-Promptctl-Launch` header
when present, deterministically and in O(1). `ClientInfo` carries
`launchId` + `paneId`. Each Live request grows an "Open pane" affordance
that routes to Loops (or eventually Workshop) and focuses the pane.
HAR replay synthesizes a stable launchId so replay sessions cluster too.

The legacy socket→pid heuristic stays only as the fallback for untagged
traffic.

### E. Context Workshop — adopt live session files

**Outcome:** When a launched Claude tool writes its `.jsonl` session file
under `~/.claude/projects/`, the Workshop sidebar surfaces it under a
"Live launches" group. The user can "Adopt" → opens the file in the
editor with a live-tail banner. Destructive ops are gated while the file
is being appended to by the live tool.

### F. Workshop tab — the unifying surface

**Outcome:** A new top-tab. "New launch" wizard picks cwd + tool + name,
spawns through the launch registry. Active-launches list shows every
running launch with terminal + live request stream + session file path
side by side. Cross-tab deep links land here from Live and Loops.

This is the surface that makes the rest of the work feel like one product
instead of four loosely-related tabs.

### G. Context Workshop — unified transformation pipeline

**Outcome:** Every operation Workshop performs (Remove Marked, Auto-Trim,
Compress Tools, Smart Compress, Topic Focus) is a Step in one ordered
Pipeline. Analyzers propose Steps with pre-filled targets and rationale;
the user assembles a Pipeline; Apply executes it as one transaction → one
versioned history entry. Apply output always passes structural validation.

The current per-operation save flows go away.

### H. Live tab — rich request inspection

**Outcome:** Live becomes a true inspector. Structured block renderers
(text / tool_use / tool_result / thinking) — *shipped*. Beyond that:
stop-reason flow strip across a chain, latency/throughput sparklines,
content-addressed system-prompt view with churn surfacing, filter chips,
substring search scoped to a client, prompt-diff across chain showing
how system + tools evolved.

---

## What is intentionally not on the list

- **Persistence beyond the current HAR file** for Live — longer history,
  search over past recordings. Separate epic when needed.
- **Non-Anthropic provider support** in the proxy — OpenAI/Gemini SSE
  parsers. Separate epic.
- **Edit-and-replay** of captured requests. Separate epic.
- **Cross-OS support.** macOS is the target.
- **External users / backwards compatibility.** This is an exploration
  tool. Rename freely, delete freely, no shims.
