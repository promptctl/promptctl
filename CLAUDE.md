# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also: @AGENTS.md — agent commit discipline + lit issue-tracker integration. See @README.md for the project's intent.

## Commands

```sh
npm start                  # tsx scripts/dev.ts — Electron Forge with main+preload Vite watcher and auto-restart
npm test                   # FULL gate: vitest (unit + tmux integration) + Playwright e2e (auto-packages first). Runs unconditionally — no opt-in env var.
npm run test:unit          # vitest only (unit + tmux integration, no e2e) — fast inner loop while iterating
npm run test:watch         # vitest watch mode
npx vitest run <path>      # single file, e.g. src/main/tasks/runner.test.ts
npx vitest run -t "<name>" # tests whose name matches a substring
npm run test:e2e           # playwright; pretest:e2e re-runs `electron-forge package` so it can never target a stale binary
npm run typecheck          # tsc --noEmit
npm run lint               # eslint src/
npm run format             # prettier --write
npm run package            # electron-forge package (unsigned, platform-native)
npm run schema:extract     # regenerate session-format schemas under docs/session-formats/
npm run schema:check       # CI guard: schemas reflect current source roots
npm run tokens:validate    # validate tiktoken estimator against an API-billed JSONL
```

`justfile` exposes `just dev` as an alias for `npm start`.

**`npm test` is the gate that must pass before every commit.** Unit + tmux integration + Playwright e2e — all unconditional. tmux is a hard project requirement (see README boundaries), so the historical `TMUX_INTEGRATION=1` opt-in served no purpose except hiding regressions until the next slice tripped over them. It is gone. The `pretest:e2e` script forces a fresh `electron-forge package` so e2e can never target stale code — that footgun cost real time during the 77e.1.4 slice.

**Convention split:** vitest owns `*.test.ts(x)` (units) and `*.integration.test.ts` (real-tmux integration). Playwright owns `*.spec.ts` under `tests/e2e/`.

## Top tabs — distinct product areas

`src/renderer/App.tsx` declares four tabs that share almost nothing functionally; the only common boot is the tmux/output/command/proxy subscriptions in `App.useEffect`. Identify the owning tab before editing.

### 1. Loops (`/loops/*`) — the tmux control plane
The tmux state model is the foundation. Sub-pages: **Panes** (live output + input + process tree), **Commands** (declarative "do X when Y" rules — triggers: manual / interval / idle / cron / output-pattern; actions: send-keys, send-command, notify, capture-output, kill-pane, log; persisted to `~/.promptctl/commands.json`), **Prompts** (markdown prompt library in the in-repo `prompts/` directory; loaded via `app.getAppPath()` and checked into git so prompts travel with the repo). `isIdle`, `launchTool`, `toolKind` detection in `src/main/tmux/controllable.ts` assume `bash/zsh/fish/sh/dash` shells and `claude/codex/gemini` tools — no tmux means not supported.

### 2. Context Workshop (`/workshop` → `SessionsPage` → `SessionEditor`) — session editor
Goal: extract the essential context from a long AI coding conversation so a new session can be seeded cheaply. Conversations are on disk as JSONL (Claude) or JSON (Gemini); the tab parses, renders, and edits them in place with versioned safety. Pipeline: discover → load → mark for removal (manual / Auto-Trim heuristics / Smart Compress via LLM / Topic Focus via LLM) → unified **Compress Tools** operation that token-thresholds tool results into summarize / middle-truncate / skip → save through the versioning coordinator. `ProviderAdapter` (`src/main/sessions/types.ts`) is the seam — Claude and Gemini are registered in `main.ts`; new providers are one adapter + one `registerProvider()` call. Token counting uses tiktoken's `gpt-4o` encoding (`src/main/sessions/tokenizer.ts`) as a directional approximation of Claude's tokenizer.

### 3. Live (`/live` → `Live`) — the request capture proxy
A loopback HTTP/HTTPS proxy in `src/main/proxy/` records every request to `api.anthropic.com` (or whatever `proxyTarget` is set to), assembles SSE streams, and broadcasts `ProxyEvent`s. The renderer projects events into `RequestRecord`s via `src/renderer/store/proxy.ts` and renders them with lineage + usage + stop-reason analysis. HAR files persist to `~/.promptctl/proxy-recordings/`; `replayHarFile` re-emits captured traffic through the same event path so live and replay are indistinguishable downstream.

### 4. Settings (`/settings` → `Settings`) — app-wide configuration
OpenAI API key + model (powers Smart Compress, Topic Focus, and tool-result summarization — separate cheap-model path from the user's Claude subscription). Compression thresholds. Proxy port/target/recordings dir. Anthropic key only feeds the offline calibration harness, not chat. Stored at `~/.promptctl/settings.json`. The `lastRoute` key drives route restoration via `RouteRestorer` in `App.tsx`.

## Architecture

### Main process owns state; renderer is a projection
The Electron main process runs long-lived subsystems and owns mutable state. The renderer holds Zustand stores that mirror these subsystems (`src/renderer/store/{tmux,command,pane-output,prompt,sessions,tasks,proxy}.ts`). Stores subscribe on mount via `init*Subscription()` helpers and treat IPC events as the source of truth — never cache independently.

Subsystems wired in `src/main/main.ts::app.whenReady`:
- `TmuxStateManager` (`src/main/tmux/state.ts`) — legacy 2s polling, broadcasts `tmux:snapshot` only on diff.
- `PaneOutputManager` (`src/main/tmux/output.ts`) — legacy `pipe-pane` + file polling, emits `tmux:pane-output`.
- `TmuxControlConnection` (`src/main/tmux/control.ts`) — event-driven control-mode client; produces snapshots/output via `TmuxTopologyTracker` and `TmuxOutputRouter`. Runs alongside the legacy polling stack until the cutover slice retires it. Only the legacy stack drives Loops today.
- `CommandEngine` (`src/main/command/engine.ts`) — unified scheduler + matcher. Triggers fire → actions execute → events broadcast. `[LAW:one-type-per-behavior]` collapses former `SchedulerEngine` + `MatcherEngine`.
- `proxyManager` (`src/main/proxy/index.ts`) — module-scope singleton. One proxy per app process; auto-starts on launch, lazy-creates the HAR file on first response.
- `deepLinkServer` (`src/main/deep-link-server.ts`) — HTTP loopback for `promptctl://` dispatch when the URL scheme can't reach Electron in dev. Port written to `~/.promptctl/deep-link-port`.
- Session-editor singletons (`src/main/sessions/editor.ts`) — active adapter, active file path. Versioning store at `~/.promptctl/versions/<hash>/` (linear history with redo drop).

### IPC contract
`preload.ts` exposes a thin pass-through (`window.electronAPI` with `send`/`invoke`/`on`, plus `window.tmuxIpc` for the `tmux-control-mode-js` library bridge). Channels are domain-namespaced: `tmux:*`, `command:*`, `prompt:*`, `session:*`, `settings:*`, `llm:*`, `task:*`, `proxy:*`. Main-side handlers register in `src/main/ipc/*.ts` and wire up in `app.whenReady`. Renderer types live in `src/renderer/env.d.ts` — keep the overloaded `invoke(channel, …)` signatures in sync with main-side handlers. **Never import main-process modules from the renderer.** Shared shapes live in `src/shared/types.ts` and `src/shared/proxy-events.ts`.

### Settings shape is duplicated by design
`AppSettings` in `src/main/settings/store.ts` and `AppSettingsShape` in `src/renderer/env.d.ts` are intentional mirrors — the renderer can't import main. Add new keys to both.

### The task seam — cancel + progress for every long-running op
`src/main/tasks/runner.ts` exposes `runTask(id, meta, op)`, which wraps any async operation with an `AbortSignal` (hand it to `chatComplete` and other libraries so cancel actually aborts HTTP), `reportProgress(done, total, message?)`, and `throwIfCancelled()` for loop boundaries. Lifecycle events stream over `task:event`. Renderer-side: `useTaskSubscription`, `cancelTask`, `newTaskId` in `src/renderer/store/tasks.ts` + `TaskToast`. IDs are renderer-supplied so subscribers attach before invoke fires — no race. **Every new long-running main-process op should route through `runTask`.** Smart Compress, Topic Focus, and Compress Tools already do.

### Session-editor versioning coordinator
`src/main/sessions/editor.ts` is the **only** entrypoint for session mutations. It calls the active adapter, then `ensureBaseline()` (snapshots the pre-edit file once) and `recordVersion()` with a human-readable label. `undo`/`redo`/`restoreVersion` move the head pointer and write the target content back. Adapters MUST NOT write to disk except through `saveSession()` — the coordinator's invariants depend on it.

### Adapter pattern for providers
`ProviderAdapter` (`src/main/sessions/types.ts`) is designed for JSONL-native formats (Claude); JSON formats (Gemini) are the degenerate case. Adapters own logical→physical index mapping (JSONL files contain non-visible lines that must be preserved), return provider-agnostic `MessageSummary[]`, and supply `ProviderUIMetadata` (badges, colors, flag definitions, help text) as **data** — the renderer never branches on provider kind.

### The proxy — capture is dataflow, not control flow
`src/main/proxy/server.ts` owns the per-request lifecycle: read body, call upstream, tee response, emit events. `[LAW:dataflow-not-control-flow]` is load-bearing here — there is no "is this an Anthropic call" branch; provider-aware logic dispatches off URL via a registry. The `ResponseAssembler` reconstructs full responses from SSE frames; `client-identity.ts` resolves stable client IDs across reconnects.

## Conventions

- **Architectural law comments**: files declare invariants with `// [LAW:<token>]` (e.g. `single-enforcer`, `one-source-of-truth`, `dataflow-not-control-flow`, `one-type-per-behavior`, `no-defensive-null-guards`). Preserve and add these when invariants are non-obvious — they're shared vocabulary across the codebase.
- **No backwards-compat shims.** From the README: "no legacy, no backwards compatibility, no external users to worry about." Prefer deleting code over shimming. Rename freely. If you refactor an API, update all callers including tests.
- **Tests are real.** `*.integration.test.ts` hits real temp dirs and (under `TMUX_INTEGRATION=1`) real tmux servers end-to-end with per-test `-L <socket>` isolation. `*.test.ts` for units. Renderer component tests use `src/test/electron-mock.ts` — `installElectronMock()` + `setInvokeHandlers({channel: handler})` per test, and `api.emit("task:event", …)` to simulate main→renderer broadcasts.

## Dev port group

`scripts/dev.ts` reserves a contiguous range and `main.ts` exposes the renderer CDP port:
- **48599** — Renderer Chrome DevTools Protocol (`PROMPTCTL_CDP_PORT` overrides; written to disk for discovery).
- **53991** — Proxy HTTP listener (default; configurable in Settings).
- **53992** — Proxy TLS listener.
- **53993** — V8 Inspector on the Electron main process (`--inspect=53993`, attach via `mcp__electric-cherry__v8_connect port=53993`).

`PROMPTCTL_TMUX_SESSION` overrides the auto-derived tmux session name (default: `ownedSessionName(app.getAppPath())`); used by e2e tests to pin a known target.

## What lives where

- `src/main/` — Electron main: tmux (legacy polling + new control-mode), command engine, sessions, proxy, IPC handlers, LLM client, task runner, settings store, deep-link.
- `src/renderer/` — React UI, Zustand stores, page components, and the `env.d.ts` IPC type contract.
- `src/shared/` — `types.ts` and `proxy-events.ts` — canonical shapes shared across the process boundary.
- `src/test/` — shared test helpers (`electron-mock.ts`, `setup.ts`).
- `tests/e2e/` — Playwright `*.spec.ts` (gated on `TMUX_INTEGRATION=1`).
- `scripts/` — `dev.ts` (the wrapper that runs Forge + Vite watcher), `schema/` (session-format schema extraction), `validate-tokens.ts`.
- `docs/anthropic-api/` — reference material for Anthropic features (context editing, prompt caching, memory tool, context windows).
- `docs/session-formats/` — generated session-format schemas; CI guards via `npm run schema:check`.
- `prompts/` (in-repo) — prompt library, edited via the in-app `PromptLibrary` UI and checked into git so prompts travel with the repo.
- `~/.promptctl/` (user's home, not in-repo) — runtime state: `settings.json`, `commands.json`, `versions/`, `proxy-recordings/`, `deep-link-port`.
