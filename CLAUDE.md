# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also: @AGENTS.md — tool-neutral agent workflow for this repo (issue tracking via `lit`).

## Commands

```sh
npm start                 # Electron Forge dev with HMR (both main + renderer)
npm run typecheck         # tsc --noEmit
npm run lint              # eslint src/
npm test                  # vitest run (single pass)
npm run test:watch        # vitest watch mode
npx vitest run <path>     # run a single file, e.g. src/main/tasks/runner.test.ts
npx vitest run -t "<name>"  # run tests whose name matches a substring
npm run format            # prettier --write
npm run package           # Electron Forge package (unsigned, platform-native)
```

`justfile` exposes `just dev` as an alias for `npm start`.

## The app has three top-level tabs — treat each as a distinct product area

The tab bar is declared in `src/renderer/App.tsx` (`TopTabBar`). The tabs share almost nothing functionally — only the tmux subscription boot in `App.useEffect`. When working in this repo, first identify which tab owns the feature.

### 1. Loops (`/loops/*`) — the tmux control plane

**Goal:** treat AI coding assistants as controllable processes, not interactive-only tools. Users run Claude Code, Codex, Gemini CLI, etc. inside tmux; this tab watches those panes, sends them input, captures output, and automates recurring actions.

**Subsections (left sidebar):**
- **Panes** (`Home` → `PaneViewer`) — pick a tmux pane, see live output, type into it, view its process tree.
- **Commands** (`CommandsPage` → `CommandPanel`) — create declarative "do X when Y" rules. Triggers: manual / schedule (interval, idle, cron) / output-pattern matcher. Actions: send-keys, send-command, notify (native notification), capture-output, kill-pane, log. Persisted to `~/.promptctl/commands.json`.
- **Prompts** (`PromptsPage` → `PromptLibrary`) — small markdown prompt files in the repo's `prompts/` directory (loaded via `app.getAppPath()`, checked into git) that can be copied or injected into panes.

**Key constraint:** tmux is the API. `isIdle`, `launchTool`, and `toolKind` detection in `src/main/tmux/controllable.ts` all assume `bash/zsh/fish/sh/dash` as shells and `claude/codex/gemini` as tools. No tmux → not supported.

### 2. Context Workshop (`/workshop` → `SessionsPage` → `SessionEditor`) — session editor

**Goal:** extract the essential context from a long AI coding conversation so the user can seed a new session cheaply, without re-reading the entire transcript. The conversations are on disk as JSONL (Claude) or JSON (Gemini); this tab parses, renders, and edits them in place with versioned safety.

**Pipeline (conceptual):**
1. Discover projects/sessions across all registered providers (`listAllProjects`, `listSessions`).
2. Load a session → adapter returns `MessageSummary[]` with logical indices.
3. User marks messages for removal (manual clicks, Auto-Trim heuristics, Smart Compress via LLM, Topic Focus via LLM).
4. Unified **Compress Tools** operation replaces bulky tool results: token thresholds dispatch to LLM summarize (large), middle-truncate (medium), or skip (small). Configurable in Settings.
5. Save → adapter writes the file; the **versioning coordinator** records a pre-edit baseline + post-edit snapshot so every change is undoable.

**Provider adapters** (`ProviderAdapter` in `src/main/sessions/types.ts`) are the seam for supporting new tools. Claude and Gemini are registered in `main.ts`; adding a provider is one adapter + one `registerProvider()` call.

**Token counting uses tiktoken's `gpt-4o` encoding** (`src/main/sessions/tokenizer.ts`) as an approximation of Claude's tokenizer — directionally correct, not exact.

### 3. Settings (`/settings` → `Settings`) — app-wide configuration

OpenAI API key + model (powers Smart Compress, Topic Focus, and LLM-backed tool-result summarization — user's subscription covers their main Claude usage, this is a separate cheap-model path for analysis). Compression thresholds (summarize/truncate/keep-last-N). Stored at `~/.promptctl/settings.json`. The `lastRoute` key drives route restoration via `RouteRestorer` in `App.tsx`.

## Architecture

### Main process owns state; renderer is a projection

Electron main process runs long-lived subsystems and owns all mutable state:
- `TmuxStateManager` (`src/main/tmux/state.ts`) — polls `discoverPanes()` every 2s, broadcasts `tmux:snapshot` only on diff.
- `PaneOutputManager` (`src/main/tmux/output.ts`) — wraps `tmux pipe-pane` + file polling; streams `tmux:pane-output` chunks.
- `CommandEngine` (`src/main/command/engine.ts`) — unified scheduling + output-matching engine. Triggers fire → actions execute → events broadcast.
- Session editor state (loaded adapter, active file path) in `src/main/sessions/editor.ts` as module-scope singletons.
- Versioning store at `~/.promptctl/versions/<hash>/` (linear history with redo drop).

The renderer holds Zustand stores that mirror these subsystems (`src/renderer/store/{tmux,command,pane-output,prompt,sessions,tasks}.ts`). Stores subscribe on mount via `init*Subscription()` helpers and treat IPC events as the source of truth — never cache independently.

### IPC contract

- `preload.ts` is a thin pass-through (`send`/`invoke`/`on`). Types live in `src/renderer/env.d.ts` — keep the overloaded `invoke(channel, …)` signatures in sync with the main-side handlers.
- Channel namespacing by domain: `tmux:*`, `command:*`, `prompt:*`, `session:*`, `settings:*`, `llm:*`, `task:*`.
- Main-side handlers are registered in `src/main/ipc/*.ts` and wired up in `main.ts::app.whenReady`.
- Shared types live in `src/shared/types.ts` — both main and renderer import from here. Never import main-process modules from the renderer.

### The task seam — cancel + progress for every long-running op

`src/main/tasks/runner.ts` exposes `runTask(id, meta, op)` which wraps any async operation with:
- AbortSignal (handed to the op via `TaskHandle.signal` — pass through to `chatComplete` and other libraries so cancel actually aborts HTTP).
- `reportProgress(done, total, message?)` → broadcasts on `task:event`.
- Cancellation check (`handle.throwIfCancelled()` at loop boundaries).
- Lifecycle events: `started` → `progress*` → `done`/`cancelled`/`error`.

Renderer: `src/renderer/store/tasks.ts` (`useTaskSubscription`, `cancelTask`, `newTaskId`) + `TaskToast` component. IDs are renderer-supplied so subscribers attach before the invoke fires — no race.

**Every new long-running main-process operation should route through `runTask`.** Smart Compress, Topic Focus, and Compress Tools already do — don't invent a parallel progress channel.

### Session-editor versioning coordinator

`src/main/sessions/editor.ts` is the **only** entrypoint for session mutations. It:
1. Calls the active adapter.
2. After success, calls `ensureBaseline()` (snapshots the pre-edit file once) and `recordVersion()` with a human-readable label.
3. `undo`/`redo`/`restoreVersion` move the head pointer and write the target content back to disk.

Adapters must NOT write to disk themselves except through `saveSession()` — the coordinator's invariants depend on it.

### Adapter pattern for providers

`ProviderAdapter` (`src/main/sessions/types.ts`) is designed for JSONL-native formats (Claude); simpler JSON formats (Gemini) are the degenerate case. Adapters:
- Own the logical→physical index mapping internally (JSONL files contain non-visible lines we must preserve).
- Return provider-agnostic `MessageSummary[]` shaped by `src/shared/types.ts`.
- Supply `ProviderUIMetadata` (badges, colors, flag definitions, help text) as **data** — the renderer never branches on provider kind.

## Conventions in this codebase

- **Architectural law comments**: files declare invariants with `// [LAW:<token>]` (e.g. `single-enforcer`, `one-source-of-truth`, `dataflow-not-control-flow`, `one-type-per-behavior`). Preserve and add these when the invariant is non-obvious; they are referenced across the codebase as shared vocabulary.
- **No backwards-compat shims.** From the README: "no legacy, no backwards compatibility, no external users to worry about." Prefer deleting code over shimming. Rename freely. If you refactor an API, update all callers including tests.
- **Tests are real.** `*.integration.test.ts` hits real temp directories end-to-end; `*.test.ts` for units. Renderer component tests use `src/test/electron-mock.ts` — `installElectronMock()` + `setInvokeHandlers({channel: handler})` per test, and `api.emit("task:event", …)` to simulate main→renderer broadcasts.
- **Settings shape is duplicated** between `src/main/settings/store.ts` (`AppSettings`) and `src/renderer/env.d.ts` (`AppSettingsShape`). The renderer can't import main-process modules, so the mirror is intentional — keep the two in sync when adding keys.

## Dev port group

`scripts/dev.ts` reserves a contiguous range for the running dev app:
- **53991** — proxy HTTP listener
- **53992** — proxy TLS listener
- **53993** — V8 Inspector on the Electron main process (`--inspect=53993`, attach with `mcp__electric-cherry__v8_connect port=53993`)

Renderer CDP is auto-allocated by Electron (look it up via `lsof` on the renderer PID, then `mcp__electric-cherry__chrome connect`). Keep new dev-only listeners in this block.

## What lives where (at a glance)

- `src/main/` — Electron main process (tmux, command engine, sessions, IPC handlers, LLM client, task runner, settings store).
- `src/renderer/` — React UI, Zustand stores, page components, and the `env.d.ts` IPC type contract.
- `src/shared/types.ts` — canonical data shapes shared across the process boundary.
- `src/test/` — shared test helpers (`electron-mock.ts`, `setup.ts`).
- `docs/anthropic-api/` — reference material for Anthropic features (context editing, prompt caching, memory tool, context windows).
- `~/.promptctl/` (user's home, not in-repo) — runtime state: `settings.json`, `commands.json`, `versions/`.
- `prompts/` (in-repo) — prompt library files, edited via the in-app `PromptLibrary` UI and checked into git so prompts travel with the repo.
