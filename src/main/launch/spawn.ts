// [LAW:single-enforcer] Sole site that creates a tagged launch. The spawn
// flow assembles the env block (which embeds the launchId), runs
// `new-session` through the control connection, registers the launch row,
// and waits for the pane-cmd subscription to confirm the tool started.
// No other code path constructs a launch — that's the registry's invariant.
//
// [LAW:dataflow-not-control-flow] One sequence every time: build env →
// run new-session → resolve pane → register → wait for confirmation →
// markRunning OR markExited. Variability lives in the spec (toolKind,
// cwd, sessionName), never in branches that choose which steps to run.

import type { TmuxClient } from "tmux-control-mode-js";
import { tmuxEscape } from "tmux-control-mode-js/protocol";
import type {
  Launch,
  LaunchId,
  LaunchSpec,
  PaneId,
  SessionId,
  ToolLaunchKind,
  TmuxSnapshot,
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

// Topology dependency narrowed to the two methods we touch — keeps the
// unit tests from needing to mock the full tracker.
export interface SpawnTopology {
  snapshot(): TmuxSnapshot;
  onSnapshot(listener: (snapshot: TmuxSnapshot) => void): () => void;
}

export interface SpawnDeps {
  readonly registry: LaunchRegistry;
  readonly topology: SpawnTopology;
  // Returns the live client or null between disconnect and reconnect-ready.
  readonly getClient: () => TmuxClient | null;
  // Returns the proxy's listening port so the env block can point the
  // tool at the loopback proxy. Resolved at call time so a proxy restart
  // (changed port) doesn't strand pre-baked env blocks.
  readonly getProxyPort: () => number;
  // Caps the wait for the tool to appear in pane-cmd. Default 5s.
  readonly toolStartTimeoutMs?: number;
  // Test seam for the launchId. Default crypto.randomUUID().
  readonly newLaunchId?: () => LaunchId;
  // Test seam for the toolKind → binary mapping. Default
  // DEFAULT_TOOL_BINARIES. Integration tests override this to point
  // the launch at a stub script under a controlled PATH; production
  // never sets it.
  readonly toolBinaries?: Record<ToolLaunchKind, string>;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function spawnLaunch(deps: SpawnDeps, spec: LaunchSpec): Promise<Launch> {
  const client = deps.getClient();
  if (client === null) {
    // Loud failure surfaces in LaunchToolDialog. The control connection
    // is between disconnect and reconnect-ready — the user can retry.
    throw new Error(
      "tmux control connection is not ready — try again in a moment",
    );
  }

  // Reject collisions up front. tmux's `new-session -d -s NAME` in
  // control mode does NOT consistently raise `%error duplicate session`
  // when NAME exists — under some tmux versions it silently creates a
  // detached duplicate-named window-like resource. A pre-check via
  // has-session gives us deterministic collision rejection. The library
  // throws on tmux's `%error` reply; we pattern-match the "can't find
  // session" text (the steady-state "doesn't exist" reply) and treat
  // everything else as propagating.
  if (await sessionExists(client, spec.sessionName)) {
    throw new Error(`tmux session "${spec.sessionName}" already exists`);
  }

  // Generate the launch ID up front — the env block embeds it, and the
  // env block is baked into the shell command before tmux runs.
  const launchId = (deps.newLaunchId ?? (() => crypto.randomUUID() as LaunchId))();
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
  await client.execute(
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
  const listResp = await client.execute(
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

  // Register the row now so consumers (Live, future subscriptions) can
  // see it even before the tool is confirmed to have started.
  const pending = deps.registry.create({
    launchId,
    spec,
    paneId,
    sessionId,
    windowId,
    env,
  });

  // [LAW:dataflow-not-control-flow] Confirmation arrives as a data flip on
  // the pane's currentCommand (matched against toolKind). The waiter
  // resolves the moment a snapshot shows the match, or times out — same
  // code path for every spawn.
  const confirmed = await waitForToolInPane(
    deps.topology,
    paneId,
    spec.toolKind,
    deps.toolStartTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!confirmed) {
    deps.registry.markExited(pending.launchId, "tool failed to start");
    throw new Error(
      `Tool ${binary} did not start in "${spec.sessionName}" within ${
        deps.toolStartTimeoutMs ?? DEFAULT_TIMEOUT_MS
      }ms`,
    );
  }

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
async function sessionExists(client: TmuxClient, name: string): Promise<boolean> {
  try {
    const resp = await client.execute(`has-session -t =${tmuxEscape(name)}`);
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
        ? (err as Error & { response: { output: string[] } }).response.output.join("\n")
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

// Exported for unit testing.
//
// NOTE [LAW:locality-or-seam]: This predicate compares pane.toolKind
// (derived from `pane_current_command` via detectToolKind) to the
// expected toolKind. In tmux configurations where `default-command` or
// `default-shell` wraps shell-command in an interactive shell (e.g.
// `/bin/zsh -l`), pane_current_command reports the wrapping shell, not
// the launched binary — `waitForToolInPane` then times out even though
// the binary is running as a child. The correlator's exit-detection
// inherits the same coupling. Tracked as a follow-up; the production
// fix likely sets `default-command ""` on launches we spawn, or
// switches detection to a pid-change signal.
export async function waitForToolInPane(
  topology: SpawnTopology,
  paneId: PaneId,
  toolKind: ToolLaunchKind,
  timeoutMs: number,
): Promise<boolean> {
  // Race: the snapshot stream against a deadline. The listener calls
  // back synchronously with the current snapshot on attach (topology's
  // onSnapshot contract), so a tool that already started by the time
  // we ask is detected immediately.
  //
  // Subscription-leak hazard: when the sync first call settles the
  // promise, `unsubscribe` hasn't been assigned yet — but the topology
  // tracker still adds the listener to its set AFTER returning from
  // the sync call. If we don't run the unsubscribe handle once it
  // exists, the listener stays in the set forever (one leak per
  // spawn). The `unsubAfterAttach` flag records the intent so we can
  // honor it the moment the handle becomes available.
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let unsubAfterAttach = false;
    const stop = () => {
      if (unsubscribe !== null) unsubscribe();
      else unsubAfterAttach = true;
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      resolve(false);
    }, timeoutMs);
    unsubscribe = topology.onSnapshot((snapshot) => {
      if (settled) return;
      const pane = snapshot.panes.find((p) => p.id === paneId);
      // [LAW:no-defensive-null-guards] pane absence is a real state
      // (new-session result hasn't propagated through subscriptions yet),
      // not a bug — we keep waiting for the next snapshot.
      if (pane && pane.toolKind === toolKind) {
        settled = true;
        clearTimeout(timer);
        stop();
        resolve(true);
      }
    });
    if (unsubAfterAttach) unsubscribe();
  });
}
