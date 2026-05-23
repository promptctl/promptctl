# tmux-control-mode-js — Application Integration Plan

This document specifies how `@promptctl/tmux-control-mode-js` (already
declared in `package.json` as `tmux-control-mode-js`, file-linked from
`../tmux-control-mode-js`) becomes the spine of promptctl. Every tab
consumes from the same identity and pane registry; nothing else holds
authoritative tmux state.

> Status: planning artifact, not yet implemented. Tickets tracked in `lit`
> under epic `promptctl-tmux-integration-program-*`. This file is the
> reference doc those tickets cite.

---

## 1. What we delete

These modules disappear and are not replaced 1:1 — the library does the
job better and the surface area shrinks:

- `src/main/tmux/state.ts` — polling-based snapshot. Replaced by the
  control-mode connection's `%window-add` / `%window-close` /
  `%session-window-changed` / `%subscription-changed` events. No more 2s
  poll loop.
- `src/main/tmux/output.ts` — `pipe-pane` + file polling. Replaced by
  `%output` / `%extended-output` notifications.
- `src/main/tmux/client.ts` — every function shells out a fresh tmux
  process. Replaced by `TmuxClient` methods (`listPanes`, `sendKeys`,
  `splitWindow`, `setSize`, `setPaneAction`).
- `src/main/tmux/controllable.ts` — ad-hoc tool launching. Replaced by
  the launch registry (§3) using `splitWindow` / `new-session` through the
  control connection.
- `src/main/tmux/exec.ts` — sole consumer of one-shot tmux. Gone.
- `src/main/ipc/tmux-handlers.ts` — application-level wrappers replaced
  by the library's `createMainBridge` plus a thin "launch" channel set.
- `src/renderer/store/tmux.ts` — restructured around the new event shape.

What stays: `processes.ts` (PID-based child enumeration via `ps` is
orthogonal to tmux), the proxy assembler/recorder, the session-editor
adapters, the task runner, settings.

No legacy shims. The library API replaces the surface and every caller
moves with it.

---

## 2. The data spine

Three first-class entities, owned by the main process. Renderers project
them; nothing else owns mutable state.

### 2.1 `TmuxControlConnection` (singleton)

A mesh of `TmuxClient` instances per tmux server — one **primary** attached
to the promptctl-owned session, plus one **follower** per *observed* foreign
session. Every client is configured `pause-after=2` and auto-resumes its
own paused panes internally. `%output` arrives only from the session each
client is attached to (tmux behavior — verified empirically), so coverage
across sessions is what gates multi-session live output and output-pattern
matching.

```
                       TmuxControlConnection
                       │
   spawnTmux(t=<owned>) ├──→ primary  TmuxClient  ── %output / topology
                       │
   spawnTmux(t=$5)    ──┤──→ follower TmuxClient  ── %output (session $5)
   spawnTmux(t=$8)    ──┤──→ follower TmuxClient  ── %output (session $8)
                       …
```

`on(event, handler)` classifies per event type:

- **Session-scoped** (`output`, `extended-output`, `pause`, `continue`) —
  attached to *every* client; events fan in from each follower's attached
  session.
- **Server-scoped** (topology events, `subscription-changed`, lifecycle) —
  attached to *primary only* so consumers see each event exactly once.

The follower set is a projection of the topology snapshot: `main.ts` wires
`topology.onSnapshot → conn.observeSessions(<foreign session ids>)`,
making "which sessions are observed" data on every snapshot rather than an
imperative `switch-client` call. The owned session is excluded by the
wiring filter (the primary already covers it). Sessions appearing in the
snapshot spawn followers; sessions disappearing tear them down — both
through the same `observeSessions(set)` reconciler.

Recovery from an unexpected follower failure does not depend on the
topology firing again (it's diff-gated and may not). Instead, the
connection schedules a per-session backoff respawn timer when a
follower's transport drops, setFlags rejects, or the transport factory
throws — but only if the session is still in `this.observed`. The
timer is a single shot; `observeSessions()` cancels any pending timer
for a session that has left the set, so a session that genuinely died
never races an attempt to attach to a vanished target.

Subscriptions registered at startup (on the primary only):

| Name              | What  | Format                                               | Drives               |
|-------------------|-------|------------------------------------------------------|----------------------|
| `pane-cmd`        | `%*`  | `#{pane_current_command}`                            | tool-kind detection  |
| `pane-cwd`        | `%*`  | `#{pane_current_path}`                               | cwd-aware launches   |
| `pane-pid`        | `%*`  | `#{pane_pid}`                                        | proxy correlation    |
| `pane-active`     | `%*`  | `#{pane_active}`                                     | UI focus mirror      |
| `pane-size`       | `%*`  | `#{pane_width}x#{pane_height}`                       | resize coalescing    |
| `window-name`     | `@*`  | `#{window_name}`                                     | tree label           |
| `session-name`    | `(s)` | `#{session_name}`                                    | tree label           |

Topology (which panes exist) comes from `%window-add` / `%window-close` /
`%session-window-changed` / `%layout-change` plus an initial
`listPanes()` capture. The result is `TmuxSnapshot` — same shape the
existing `tmux:snapshot` channel publishes today, regenerated from
events instead of polling.

[LAW:one-source-of-truth] The control connection is the single producer
of pane/window/session state. State module subscribes to it; nothing
else issues `list-*` commands.

### 2.2 `LaunchRegistry`

A `LaunchEntity` is the spine that ties tabs together:

```ts
interface LaunchEntity {
  launchId: string;            // promptctl-issued, opaque, UUID
  toolKind: "claude" | "codex" | "gemini";
  paneId: PaneId;              // tmux pane id (e.g. "%17")
  sessionId: SessionId;        // tmux session id
  windowId: WindowId;          // tmux window id
  cwd: string;
  startedAt: number;
  env: Record<string, string>; // recorded for diagnostics
  // Late-binding fields, populated as evidence arrives:
  proxyClientId: string | null;     // matched on first request header
  sessionFilePath: string | null;   // matched on first JSONL write
  exitedAt: number | null;
  exitReason: string | null;
}
```

The registry is module-scope state in main, persisted to
`~/.promptctl/launches.json` so a promptctl restart doesn't orphan
already-running tools. Every change emits `launch:event` to subscribed
renderers.

[LAW:single-enforcer] Exactly one site creates `LaunchEntity` rows
(launch invocation), one site updates them (correlator services), one
site deletes them (exit detector). No tab mutates the registry directly.

### 2.3 Identity propagation

Three layers, three signals — all derived from `launchId`:

```
promptctl spawns
   └── tmux send-keys / new-session with shell command:
       env PROMPTCTL_LAUNCH_ID=<launchId> \
           PROMPTCTL_PANE_ID=<paneId> \
           ANTHROPIC_BASE_URL=http://127.0.0.1:53991 \
           ANTHROPIC_CUSTOM_HEADERS='X-Promptctl-Launch: <launchId>' \
           claude
            │
            ├── env vars carry id into the tool process
            ├── header carries id into every proxy request
            └── pane currentCommand changes — control-mode subscription
                fires; LaunchRegistry promotes the launch from "pending"
                to "running" and binds paneId definitively.
```

Why three signals:

- **Env var** is recoverable post-hoc by reading `/proc/<pid>/environ`
  (Linux) or `ps -E` (BSD/macOS) when promptctl restarts and finds an
  existing tool process. It's the durable anchor.
- **Header** is what the proxy sees on every request — gives O(1)
  identity attribution without socket→pid heuristics. Replaces the
  fragile `client-identity.ts` walk for traffic we own.
- **Pane subscription** confirms the launch actually ran in the pane we
  expected (the tmux side of the link).

Existing `client-identity.ts` becomes a fallback only — for traffic from
tools we did *not* launch (a user runs a stray `claude` in another
terminal that happens to point at the proxy).

---

## 3. Tab integration

### 3.1 Loops — full rebuild on the library

The current Loops code is non-functional and we have a free hand.
Target shape:

```
Sidebar (TmuxTree)             Main pane
┌───────────────────────┐  ┌──────────────────────────────────┐
│ session-name          │  │ Pane header: tool badge, cwd     │
│   ├── window:0 …      │  │ ┌──────────────────────────────┐ │
│   └── window:1 …      │  │ │                              │ │
│ another-session       │  │ │  xterm.js Terminal           │ │
│   └── window:0        │  │ │  (driven by %output bytes)   │ │
│                       │  │ │                              │ │
│ [+ Launch in pane]    │  │ └──────────────────────────────┘ │
└───────────────────────┘  │ Composer ▌                       │
                            └──────────────────────────────────┘
```

Renderer changes:

- Each pane embeds an `xterm.js` `Terminal`. Bytes from `%output` go
  through `terminal.write()`. Keystrokes go through
  `terminal.onData(data → TmuxClient.sendKeys(target, -l data))`.
- Use the library's `keymap` engine for `C-b`-prefixed actions (split,
  kill, zoom, resize) in the renderer, dispatched via `TmuxClient`.
- Resize via `setSize(cols, rows)` from xterm.js's `onResize`.
- Pane lifecycle is driven entirely by the library's events; the
  Zustand store mirrors them.

Command engine changes:
- `CommandEngine.executeAction` calls `TmuxClient.sendKeys` instead of
  shelling out.
- "Idle" detection moves from currentCommand polling to the
  `pane-cmd` subscription emitting changes.
- Output matchers consume `output` events instead of file-poll deltas.

### 3.2 Context Workshop — live session association

MVP cut: the SessionEditor learns about live launches.

```
┌─ Sessions sidebar ──────────────┐  ┌─ Editor ────────────────┐
│ ▼ Live launches                 │  │ <existing editor>       │
│   ⏵ %17 · claude · /repo/foo   │  │ + banner: "live tail"    │
│ ▼ ~/.claude/projects/…          │  │   (file is being         │
│   foo (3 sessions)              │  │   written; destructive   │
│   bar (12)                      │  │   ops disabled)          │
└─────────────────────────────────┘  └─────────────────────────┘
```

Implementation:
- New `LiveLaunchProvider` (data source, *not* a `ProviderAdapter`) on
  the renderer side that subscribes to `launch:event` and lists active
  launches at the top of the sessions sidebar.
- For each running Claude launch, watch `~/.claude/projects/<encoded(cwd)>/`
  via `fs.watch`. The first `*.jsonl` file created with mtime ≥
  `launch.startedAt` is the live session — record it on
  `launch.sessionFilePath`.
- "Adopt" → opens that file path through the existing `claudeAdapter`.
  Live tailing is implemented by the editor coordinator polling the
  file and re-invoking `loadSession` when it grows.
- Save behavior unchanged. Versioning still applies — but we surface a
  warning when saving a file the launched tool is still appending to,
  because the tool's next message will collide with the rewrite. (That
  collision is a real risk worth a follow-up ticket; MVP is "show the
  banner, let the user decide.")

### 3.3 Live — header-driven identity, pane crosslink

Single change of substance: the proxy `client-identity.ts` learns about
the registry.

```ts
async function resolveClientId(req): Promise<ClientInfo> {
  const launchId = req.headers["x-promptctl-launch"];
  if (launchId) {
    const entry = launchRegistry.get(launchId);
    if (entry) return clientInfoFromLaunch(entry);  // O(1), deterministic
  }
  // Fallback: existing socket→pid walk for un-tagged traffic.
  return resolveByHeuristic(req.socket);
}
```

Outputs:
- A request from a launched tool always lands in the same client tab,
  with `displayName = "claude · <cwd>"` and a `paneId` field.
- The Live tab grows an "Open pane" affordance per request → routes to
  `/loops?paneId=%17` and focuses the pane.
- The existing `workshop-client-identity-5ic` epic is fulfilled by this
  ticket set rather than a parallel implementation. Its tickets are
  reparented under this program.

### 3.4 Workshop tab — the unifying surface

Workshop becomes a fourth top-tab that owns the launch lifecycle:

```
┌── Workshop ──────────────────────────────────────────────────────┐
│ + New launch  [cwd: /repo/foo  tool: claude  name: feature-X]    │
│                                                                  │
│ ▼ Active launches                                                │
│   feature-X · claude · %17 · /repo/foo · 14 reqs · 3.2 MB ses   │
│       ┌── tmux pane (xterm) ──────┬── live requests ──────┐      │
│       │                            │                       │      │
│       │   [terminal output]        │  POST /v1/messages …  │      │
│       │                            │  cache: 0.94          │      │
│       │                            │                       │      │
│       └────────────────────────────┴───────────────────────┘      │
│       Session file: ~/.claude/.../foo/abc123.jsonl                │
│       [Open in Editor] [Stop] [Detach]                            │
└──────────────────────────────────────────────────────────────────┘
```

Workshop is the *only* tab that creates launches; Loops can attach to
existing panes but can't spawn tagged launches. This keeps the registry
invariant "every launch was created by Workshop" simple.

---

## 4. IPC contract

The library ships its own bridge (`createMainBridge`) on the channels
`tmux:invoke`, `tmux:event`, `tmux:register`, `tmux:unregister`. Use
them as-is. Promptctl-specific channels layer on top:

| Channel                  | Direction          | Purpose                                              |
|--------------------------|--------------------|------------------------------------------------------|
| `launch:create`          | renderer → main    | Spawn a new tagged launch                            |
| `launch:list`            | renderer → main    | Snapshot of registry                                 |
| `launch:get`             | renderer → main    | One launch by id                                     |
| `launch:terminate`       | renderer → main    | Kill the pane / send exit                            |
| `launch:event`           | main → renderer    | Add/update/remove rows                               |
| `pane:capture`           | renderer → main    | One-shot scrollback dump for export                  |
| `proxy:request-context`  | main → renderer    | (existing, gains `launchId` field)                   |

The renderer never talks tmux directly except through the library's
proxy. The renderer never talks to `LaunchRegistry` directly except
through these channels.

---

## 5. Sequencing

This is a long body of work — the order below preserves a working app
at every step.

1. **Foundation: control-mode connection in main, IPC bridge wired**.
   The library's `createMainBridge` is installed. The new
   `TmuxControlConnection` initializes alongside the existing polling
   stack (no removal yet), so we can validate event emission before
   anything depends on it.
2. **Topology and output cut over to events**. New state module driven
   by subscriptions; old `state.ts` and `output.ts` deleted. Renderer
   continues to use the same `tmux:snapshot` shape — wire change is
   transparent.
3. **xterm.js render in renderer**. Pane viewer displays library
   `%output` bytes through xterm. Keystroke path moves to library
   `sendKeys`. Old pane-output store retired.
4. **Launch registry**. Workshop tab does not exist yet, but Loops
   "Launch in pane" routes through the new registry and tags processes.
5. **Header-driven Live identity**. Proxy reads
   `x-promptctl-launch`. Workshop-client-identity epic's tickets land
   here.
6. **Context Workshop adoption flow**. Watcher detects the JSONL file
   and "adopt" opens it in the editor.
7. **Workshop tab**. The unified surface is built last because it
   composes pieces from steps 1–6.

Each step is one or more tickets. Tickets are ranked top-to-bottom in
the order above.

---

## 6. Architectural laws referenced

- `[LAW:one-source-of-truth]` — `TmuxControlConnection` is the only
  producer of pane state; `LaunchRegistry` is the only producer of
  launch identity.
- `[LAW:single-enforcer]` — registry mutation paths funnel through the
  registry module; identity correlation has one site
  (`resolveClientId`).
- `[LAW:dataflow-not-control-flow]` — identity is data on every
  request (launchId in header) rather than a fork between "we know who
  this is" and "we don't."
- `[LAW:one-type-per-behavior]` — `LaunchEntity` is one shape consumed
  by every tab. Loops, Workshop, Live, and the new Workshop tab don't
  branch on tab kind.
- `[LAW:no-mode-explosion]` — the launch registry replaces multiple
  ad-hoc identity flows (socket walk, currentCommand sniffing, env-var
  guessing) with one flow.

---

## 7. Open questions captured for follow-up tickets

- **Reconnection.** When tmux server restarts, the control connection
  drops. We need a reconnect policy that doesn't double-tag panes the
  registry already knows about. (Re-check on launch.startedAt vs
  pane uptime.)
- **Live-tail save collision.** A user editing a JSONL file the live
  Claude is appending to is a known race. The Workshop banner is the
  MVP; an actual coordination protocol (lockfile, backpressure) is a
  later ticket.
- **Codex / Gemini header support.** Codex and Gemini do not have a
  unified custom-header env var. We may need a per-tool launch wrapper
  that sets the header via a small shim (`exec env … claude` works for
  Anthropic; the others need investigation).
- **Pane reuse.** What happens when a launch's tool exits but the pane
  (a shell) survives? The registry needs an "exited" terminal state
  that doesn't garbage-collect the row, so Live can still show the
  history.
