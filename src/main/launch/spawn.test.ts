// Unit tests for the spawn flow. The TmuxClient and topology tracker are
// stubbed — real-tmux integration coverage lives in
// spawn.integration.test.ts (slice B integration).

import { describe, expect, it, vi } from "vitest";
import {
  spawnLaunch,
  composeShellCommand,
  shellSingleQuote,
  waitForToolInPane,
  type SpawnTopology,
} from "./spawn";
import { LaunchRegistry, launchEnvBlock } from "./registry";
import type {
  LaunchId,
  LaunchSpec,
  PaneId,
  SessionId,
  TmuxPane,
  TmuxSnapshot,
  ToolLaunchKind,
  WindowId,
} from "../../shared/types";

const PANE: PaneId = "%17" as PaneId;
const SESS: SessionId = "$3" as SessionId;
const WIN: WindowId = "@5" as WindowId;

type StubResp =
  | { success: boolean; output: string[] }
  | { throws: string };

function fakeClient(responses: Record<string, StubResp>) {
  // Each call matches the longest registered key the issued command
  // starts with — keeps the test cases readable instead of matching
  // exact command strings character-for-character. A `{ throws }`
  // response throws an Error with that message (simulates the library's
  // TmuxCommandError on tmux `%error` replies).
  const calls: string[] = [];
  const client = {
    execute: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      const match = Object.keys(responses)
        .filter((k) => cmd.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (!match) {
        throw new Error(`unexpected client.execute(${cmd})`);
      }
      const resp = responses[match];
      if ("throws" in resp) {
        const err = new Error(resp.throws) as Error & {
          response: { output: string[] };
        };
        err.response = { output: [resp.throws] };
        throw err;
      }
      return resp;
    }),
  };
  return { client, calls };
}

function fakeTopology(panes: TmuxPane[]): SpawnTopology {
  const snapshot: TmuxSnapshot = { timestamp: 0, panes };
  return {
    snapshot: () => snapshot,
    onSnapshot: (listener) => {
      listener(snapshot);
      return () => undefined;
    },
  };
}

function makePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: PANE,
    sessionName: "feature-x",
    sessionId: SESS,
    windowName: "win",
    windowId: WIN,
    windowIndex: 0,
    paneIndex: 0,
    pid: 42,
    currentCommand: "claude",
    currentPath: "/repo",
    width: 80,
    height: 24,
    active: true,
    toolKind: "claude",
    ...overrides,
  };
}

describe("shellSingleQuote", () => {
  it("wraps plain values in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes via the close+escape+reopen idiom", () => {
    expect(shellSingleQuote("X'Y")).toBe("'X'\\''Y'");
  });

  it("handles spaces, colons, and equals", () => {
    expect(shellSingleQuote("X-Promptctl-Launch: abc=def")).toBe(
      "'X-Promptctl-Launch: abc=def'",
    );
  });
});

describe("composeShellCommand", () => {
  it("composes `env K=v K=v binary` with quoted values", () => {
    const env = {
      PROMPTCTL_LAUNCH_ID: "abc",
      ANTHROPIC_CUSTOM_HEADERS: "X-Promptctl-Launch: abc",
    };
    expect(composeShellCommand(env, "claude")).toBe(
      "env PROMPTCTL_LAUNCH_ID='abc' ANTHROPIC_CUSTOM_HEADERS='X-Promptctl-Launch: abc' claude",
    );
  });
});

describe("waitForToolInPane", () => {
  it("resolves true when the snapshot already shows the expected tool", async () => {
    const topology = fakeTopology([makePane({ toolKind: "claude" })]);
    expect(await waitForToolInPane(topology, PANE, "claude", 1000)).toBe(true);
  });

  it("resolves false on timeout when the pane never shows the tool", async () => {
    const topology = fakeTopology([makePane({ toolKind: "unknown" })]);
    expect(await waitForToolInPane(topology, PANE, "claude", 30)).toBe(false);
  });

  it("ignores other panes", async () => {
    const topology = fakeTopology([
      makePane({ id: "%99" as PaneId, toolKind: "claude" }),
    ]);
    expect(await waitForToolInPane(topology, PANE, "claude", 30)).toBe(false);
  });

  it("unsubscribes after a synchronous initial match (no listener leak)", async () => {
    // Production hazard: topology.onSnapshot calls the listener
    // synchronously THEN adds it to its set. If we settle on the sync
    // call, the unsubscribe handle returned from onSnapshot must
    // still run — otherwise the listener stays in the set forever.
    const listeners = new Set<(s: TmuxSnapshot) => void>();
    const snapshot: TmuxSnapshot = {
      timestamp: 0,
      panes: [makePane({ toolKind: "claude" })],
    };
    const topology: SpawnTopology = {
      snapshot: () => snapshot,
      onSnapshot: (listener) => {
        listener(snapshot); // sync call (may settle)
        listeners.add(listener); // then add to set
        return () => {
          listeners.delete(listener);
        };
      },
    };
    expect(await waitForToolInPane(topology, PANE, "claude", 1000)).toBe(true);
    expect(listeners.size).toBe(0); // no leak
  });

  it("flips to true on a later snapshot", async () => {
    let listener: ((s: TmuxSnapshot) => void) | null = null;
    const topology: SpawnTopology = {
      snapshot: () => ({ timestamp: 0, panes: [makePane({ toolKind: "unknown" })] }),
      onSnapshot: (l) => {
        listener = l;
        l({ timestamp: 0, panes: [makePane({ toolKind: "unknown" })] });
        return () => undefined;
      },
    };
    const waiter = waitForToolInPane(topology, PANE, "claude", 500);
    // Push a snapshot with the tool present.
    setTimeout(() => {
      listener?.({ timestamp: 1, panes: [makePane({ toolKind: "claude" })] });
    }, 10);
    expect(await waiter).toBe(true);
  });
});

describe("spawnLaunch", () => {
  function commonSpec(): LaunchSpec {
    return { toolKind: "claude" as ToolLaunchKind, cwd: "/repo", sessionName: "feature-x" };
  }

  function makeRegistry() {
    return new LaunchRegistry({ save: async () => undefined });
  }

  it("issues has-session → new-session → list-panes and registers a running launch", async () => {
    // has-session for a fresh name throws (tmux's `%error can't find
    // session`) — sessionExists pattern-matches that message and reads
    // it as "doesn't exist", so the spawn proceeds.
    const { client, calls } = fakeClient({
      "has-session": { throws: "can't find session: feature-x" },
      "new-session": { success: true, output: [] },
      "list-panes": { success: true, output: [`${PANE}|${SESS}|${WIN}`] },
    });
    const registry = makeRegistry();
    const topology = fakeTopology([makePane({ toolKind: "claude" })]);
    const result = await spawnLaunch(
      {
        registry,
        topology,
        getClient: () => client as unknown as never,
        getProxyPort: () => 53991,
        newLaunchId: () => "L-1" as LaunchId,
      },
      commonSpec(),
    );
    expect(result.status).toBe("running");
    expect(result.launchId).toBe("L-1");
    expect(result.paneId).toBe(PANE);
    expect(result.sessionId).toBe(SESS);
    expect(result.windowId).toBe(WIN);
    // Three commands fired in the right order.
    expect(calls[0]).toMatch(/^has-session/);
    expect(calls[1]).toMatch(/^new-session/);
    expect(calls[2]).toMatch(/^list-panes/);
    // Env block was embedded in the new-session payload.
    expect(calls[1]).toContain("PROMPTCTL_LAUNCH_ID=");
    expect(calls[1]).toContain("X-Promptctl-Launch: L-1");
    expect(calls[1]).toContain("ANTHROPIC_BASE_URL=");
  });

  it("rejects collisions via the has-session pre-check", async () => {
    // has-session for an existing session returns `%end` with success —
    // the spawn flow reads that as "exists" and throws before any
    // new-session call.
    const { client, calls } = fakeClient({
      "has-session": { success: true, output: [] },
    });
    const registry = makeRegistry();
    await expect(
      spawnLaunch(
        {
          registry,
          topology: fakeTopology([]),
          getClient: () => client as unknown as never,
          getProxyPort: () => 53991,
        },
        commonSpec(),
      ),
    ).rejects.toThrow(/already exists/);
    expect(registry.list()).toEqual([]);
    // sessionExists used tmuxEscape on the session name, which wraps in
    // single quotes — assert just the command verb here rather than the
    // full escaped form (the unit test for tmuxEscape lives in the
    // library, not in spawn).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^has-session -t =/);
  });

  it("throws when control connection is not ready", async () => {
    await expect(
      spawnLaunch(
        {
          registry: makeRegistry(),
          topology: fakeTopology([]),
          getClient: () => null,
          getProxyPort: () => 53991,
        },
        commonSpec(),
      ),
    ).rejects.toThrow(/not ready/);
  });

  it("marks the row exited when the tool does not appear within the timeout", async () => {
    const { client } = fakeClient({
      "has-session": { throws: "can't find session: feature-x" },
      "new-session": { success: true, output: [] },
      "list-panes": { success: true, output: [`${PANE}|${SESS}|${WIN}`] },
    });
    const registry = makeRegistry();
    const topology = fakeTopology([makePane({ toolKind: "unknown" })]);
    await expect(
      spawnLaunch(
        {
          registry,
          topology,
          getClient: () => client as unknown as never,
          getProxyPort: () => 53991,
          toolStartTimeoutMs: 20,
          newLaunchId: () => "L-2" as LaunchId,
        },
        commonSpec(),
      ),
    ).rejects.toThrow(/did not start/);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("exited");
    if (list[0].status === "exited") {
      expect(list[0].exitReason).toBe("tool failed to start");
    }
  });

  it("builds the env block consistent with the launchEnvBlock helper", () => {
    // [LAW:one-source-of-truth] The env helper is shared between
    // registry and spawn — this test pins the relationship so a future
    // edit can't make them disagree silently.
    const block = launchEnvBlock({
      launchId: "X" as LaunchId,
      proxyPort: 9000,
      toolKind: "gemini",
    });
    expect(block).toEqual({
      PROMPTCTL_LAUNCH_ID: "X",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9000",
      ANTHROPIC_CUSTOM_HEADERS: "X-Promptctl-Launch: X",
      PROMPTCTL_LAUNCH_TOOL: "gemini",
    });
  });
});
