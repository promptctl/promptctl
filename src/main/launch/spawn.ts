// [LAW:single-enforcer] Sole site that creates a tagged launch. The spawn
// flow assembles the env block (which embeds the launchId), runs
// `new-session` through the control connection, registers the launch row,
// and markRunning the moment tmux acknowledges the session. No other code
// path constructs a launch — that's the registry's invariant.
//
// [LAW:dataflow-not-control-flow] One fixed sequence every spawn: build
// env → run new-session → resolve pane → register → markRunning. There
// is no "did the tool appear yet" branch. The launch's running-ness is
// derived from tmux's new-session ack; exit detection lives entirely in
// the correlator (pane vanish / window-close).
//
// [LAW:types-are-the-program] The previous shape gated `pending → running`
// on `pane.toolKind === expected`, a name-match predicate that is FALSE
// under tmux default-shell wrapping (pane_current_command reports the
// wrapping shell or wrapper-script interpreter, not the launched binary).
// Empirically pane_pid does not transition either — under a wrapper that
// forks its child, pane_pid stays at the wrapper's pid for the wrapper's
// whole life. The strongest *true* theorem about "the launch is running"
// is "new-session succeeded and tmux assigned a pane"; everything else
// was inference over a signal we cannot trust uniformly across tmux
// configurations. The body shrinks because the type carries less fiction.

import { tmuxEscape } from "tmux-control-mode-js/protocol";
import type { CommandResponse } from "tmux-control-mode-js/protocol";
import type {
  Launch,
  LaunchId,
  LaunchSpec,
  PaneId,
  SessionId,
  ToolLaunchKind,
  WindowId,
} from "../../shared/types";
import { launchEnvBlock } from "./registry";
import type { LaunchRegistry } from "./registry";

// [LAW:one-source-of-truth] The single mapping from toolKind → binary
// on PATH. Adding a tool means adding one row here. Exported so the
// main-process wiring can hand it through verbatim — and so integration
// tests can override individual entries to point at a stub.
export const DEFAULT_TOOL_BINARIES: Record<ToolLaunchKind, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

// [LAW:locality-or-seam] The spawn flow consumes tmux through one method:
// execute(). The connection's mesh routes the request to any ready client
// and rejects loudly when the mesh is empty (no-sessions). No "is the
// connection ready" branch lives here — that knowledge is in the caller's
// error handling, not in this module's control flow.
export interface SpawnDeps {
  readonly registry: LaunchRegistry;
  // Run a tmux command. Rejects when the mesh is empty (no sessions
  // observed yet) — the caller surfaces that as a user-visible "try again
  // in a moment" message.
  readonly execute: (command: string) => Promise<CommandResponse>;
  // Returns the proxy's listening port so the env block can point the
  // tool at the loopback proxy. Resolved at call time so a proxy restart
  // (changed port) doesn't strand pre-baked env blocks.
  readonly getProxyPort: () => number;
  // Test seam for the launchId. Default crypto.randomUUID().
  readonly newLaunchId?: () => LaunchId;
  // Test seam for the toolKind → binary mapping. Default
  // DEFAULT_TOOL_BINARIES. Integration tests override this to point
  // the launch at a stub script under a controlled PATH; production
  // never sets it.
  readonly toolBinaries?: Record<ToolLaunchKind, string>;
}

export async function spawnLaunch(
  deps: SpawnDeps,
  spec: LaunchSpec,
): Promise<Launch> {
  // Reject collisions up front. tmux's `new-session -d -s NAME` in
  // control mode does NOT consistently raise `%error duplicate session`
  // when NAME exists — under some tmux versions it silently creates a
  // detached duplicate-named window-like resource. A pre-check via
  // has-session gives us deterministic collision rejection. The library
  // throws on tmux's `%error` reply; we pattern-match the "can't find
  // session" text (the steady-state "doesn't exist" reply) and treat
  // everything else as propagating.
  if (await sessionExists(deps.execute, spec.sessionName)) {
    throw new Error(`tmux session "${spec.sessionName}" already exists`);
  }

  // Generate the launch ID up front — the env block embeds it, and the
  // env block is baked into the shell command before tmux runs.
  const launchId = (
    deps.newLaunchId ?? (() => crypto.randomUUID() as LaunchId)
  )();
  const binaries = deps.toolBinaries ?? DEFAULT_TOOL_BINARIES;
  const binary = binaries[spec.toolKind];
  const env = launchEnvBlock({
    launchId,
    proxyPort: deps.getProxyPort(),
    toolKind: spec.toolKind,
  });

  // The launched process runs as `env KEY=val KEY=val ... <binary>` so
  // the identity vars are visible to the child without polluting tmux's
  // own environment. Shell-quote each value because some (notably
  // ANTHROPIC_CUSTOM_HEADERS) contain spaces.
  const shellCommand = composeShellCommand(env, binary);

  // The has-session pre-check above is the collision-rejection point;
  // new-session here is expected to succeed. tmux still surfaces
  // unexpected errors (binary missing, permission denied, etc.) as a
  // thrown TmuxCommandError, which we let propagate verbatim.
  await deps.execute(
    [
      "new-session",
      "-d",
      "-s",
      tmuxEscape(spec.sessionName),
      "-c",
      tmuxEscape(spec.cwd),
      tmuxEscape(shellCommand),
    ].join(" "),
  );

  // Resolve the pane/session/window IDs for the row. tmux assigns these
  // when new-session lands, so list-panes against the new session is
  // O(1) — one pane, one line. The library throws TmuxCommandError on
  // tmux's `%error` (e.g. session died between new-session and here);
  // we let that propagate with tmux's original message.
  const listResp = await deps.execute(
    `list-panes -t ${tmuxEscape(spec.sessionName)} -F "#{pane_id}|#{session_id}|#{window_id}"`,
  );
  const line = listResp.output[0]?.trim();
  if (!line) {
    throw new Error(
      `Launched ${binary} in "${spec.sessionName}" but list-panes returned no rows`,
    );
  }
  const [paneRaw, sessionRaw, windowRaw] = line.split("|");
  if (!paneRaw || !sessionRaw || !windowRaw) {
    throw new Error(`list-panes returned malformed line: ${line}`);
  }
  const paneId = paneRaw as PaneId;
  const sessionId = sessionRaw as SessionId;
  const windowId = windowRaw as WindowId;

  const pending = deps.registry.create({
    launchId,
    spec,
    paneId,
    sessionId,
    windowId,
    env,
  });

  // [LAW:dataflow-not-control-flow] new-session's success IS the running
  // signal. Trying to derive "running" from a downstream observation
  // (pane_current_command, pane_pid) is what the prior shape did, and it
  // was wrong under every shell-wrap configuration we observed. The
  // correlator owns exit detection (pane-gone, window-close), so the
  // worst case here — the binary fails immediately — surfaces as a
  // transient running row that the next correlator pass marks exited.
  const running = deps.registry.markRunning(pending.launchId);
  if (running === null) {
    // The row vanished between create and markRunning — only possible
    // if some other code path called markExited concurrently, which
    // shouldn't happen given single-enforcer ownership. Surface loudly.
    throw new Error(
      `Launch ${pending.launchId} disappeared from registry between create and markRunning`,
    );
  }
  return running;
}

// Exported as sessionExistsForTesting; the internal callsite uses the
// short name below.
export { sessionExists as sessionExistsForTesting };

// Probes whether the named tmux session exists. tmux's reply pattern:
//  - session present     → `%end` with empty output  → resolve success
//  - session absent      → `%error can't find session: NAME` → throw
//  - other (server gone) → different error text → propagate
async function sessionExists(
  execute: (command: string) => Promise<CommandResponse>,
  name: string,
): Promise<boolean> {
  try {
    const resp = await execute(`has-session -t =${tmuxEscape(name)}`);
    // tmux 3.x returns `%end` (success) even when the session doesn't
    // exist on some configurations — but with diagnostic output in the
    // body. The robust read is: success AND no error-shaped output.
    // [LAW:no-silent-fallbacks] If output mentions "can't find session"
    // even on a `%end` success path, treat that as "doesn't exist".
    const body = resp.output.join("\n");
    if (/can't find session/.test(body)) return false;
    return true;
  } catch (err) {
    const message =
      err instanceof Error && "response" in err
        ? (
            err as Error & { response: { output: string[] } }
          ).response.output.join("\n")
        : err instanceof Error
          ? err.message
          : String(err);
    if (/can't find session/.test(message)) return false;
    throw err;
  }
}

// Exported for unit testing.
export function composeShellCommand(
  env: Readonly<Record<string, string>>,
  binary: string,
): string {
  const envParts = Object.entries(env).map(
    ([k, v]) => `${k}=${shellSingleQuote(v)}`,
  );
  return `env ${envParts.join(" ")} ${binary}`;
}

// Exported for unit testing.
//
// Wraps a value in single quotes for use inside a shell command. Inside
// single quotes the only special character is `'` itself, which we close
// + escape + reopen with the `'\''` idiom.
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
