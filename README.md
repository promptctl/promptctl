# promptctl

Local orchestration tool for AI coding assistants — Claude Code, Codex (CLI & Desktop), Gemini CLI, and whatever comes next.

## What this is

A desktop app (Electron) for controlling and coordinating local LLM coding tools. The core idea: these tools run in terminals, and terminals are programmable. promptctl gives you a UI to discover, monitor, schedule, and interact with AI coding sessions running on your machine.

**This is an exploration tool.** The goal is to understand what's possible when you treat AI coding assistants as controllable processes rather than interactive-only tools. Features get added fast, removed when they don't work, and rebuilt when we learn something new. There is no legacy, no backwards compatibility, no external users to worry about.

## Boundaries

**Hard:**
- All CLI tools run in **tmux**. No tmux, not supported. Tmux is the control plane — it gives us session discovery, pane management, input injection, and output capture for free.

**Soft:**
- **macOS** is the primary (and currently only) target.
- Electron-based tools (Codex Desktop) may get deeper integration via their app internals.

## Architecture intent

### Tmux as the foundation
The app discovers and models the full tmux hierarchy: servers → sessions → windows → panes. This state is kept up to date efficiently — not polled wastefully, not stale. Everything downstream builds on this model.

### Controllable processes
An abstraction layer over "things I want to control." Key questions this layer answers:
- Is it already running? Where?
- Do I need to start it? How?
- Can I adopt a running process, or is pre-existing fundamentally different from launched-by-me?
- How do I send input? How do I read output?

The answer varies by tool. Claude Code in a tmux pane is different from Codex Desktop as an Electron app. The abstraction handles this without leaking tool-specific details everywhere.

### Scheduling and automation
Send commands to running sessions on a schedule. "Every 5 minutes, tell Claude to check the deploy status." "When this pane goes idle for 30 seconds, send the next task." Cron-like and event-driven.

### Output streaming and history
Capture and display output from controlled processes. Stream it live in the UI. Keep history so you can review what happened while you weren't watching.

## Principles

- **Fast iteration over polish.** Add features, try them, keep what works, delete what doesn't.
- **No cruft accumulation.** Dead code gets removed. Unused abstractions get deleted. If something isn't earning its keep, it goes.
- **Tmux is the API.** Don't fight it. Don't abstract over it unnecessarily. Use what it gives you directly.
- **Stay fast.** The app must remain responsive. Heavy work happens async. The UI never blocks.

## Tech stack

- Electron Forge + Vite
- React 19 + TypeScript (strict)
- Tailwind CSS v4
- Zustand (state management)
- React Router v7
- Vitest + React Testing Library

## Development

```sh
npm start          # dev with HMR
npm test           # run tests
npm run typecheck  # type check
npm run lint       # lint
```
