// Unit tests for the spawn flow. The TmuxClient is stubbed — real-tmux
// integration coverage lives in spawn.integration.test.ts.

import { describe, expect, it, vi } from "vitest";
import { spawnLaunch, composeShellCommand, shellSingleQuote } from "./spawn";
import { LaunchRegistry, launchEnvBlock } from "./registry";
import type {
  LaunchId,
  LaunchSpec,
  PaneId,
  SessionId,
  ToolLaunchKind,
  WindowId,
} from "../../shared/types";

const PANE: PaneId = "%17" as PaneId;
const SESS: SessionId = "$3" as SessionId;
const WIN: WindowId = "@5" as WindowId;

type StubResp = { success: boolean; output: string[] } | { throws: string };

// CommandResponse requires commandNumber + timestamp; the fakeClient fills
// them in monotonically so tests don't have to.
function makeStubResponse(
  resp: { success: boolean; output: string[] },
  commandNumber: number,
) {
  return {
    success: resp.success,
    output: resp.output,
    commandNumber,
    timestamp: 0,
  };
}

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
      return makeStubResponse(resp, calls.length);
    }),
  };
  return { client, calls };
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

describe("spawnLaunch", () => {
  function commonSpec(): LaunchSpec {
    return {
      toolKind: "claude" as ToolLaunchKind,
      cwd: "/repo",
      sessionName: "feature-x",
    };
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
    const result = await spawnLaunch(
      {
        registry,
        execute: (cmd: string) => client.execute(cmd),
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
          execute: (cmd: string) => client.execute(cmd),
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

  it("propagates the mesh-empty rejection from execute()", async () => {
    // With the mesh refactor, the spawn flow no longer asks "is the
    // connection ready?" — it just calls execute(), and the connection's
    // mesh dispatch rejects loudly when no sessions are observed. The
    // spawn flow surfaces that rejection verbatim.
    await expect(
      spawnLaunch(
        {
          registry: makeRegistry(),
          execute: () =>
            Promise.reject(
              new Error("tmux control mesh is empty — no sessions observed"),
            ),
          getProxyPort: () => 53991,
        },
        commonSpec(),
      ),
    ).rejects.toThrow(/mesh is empty/);
  });

  it("marks running without inspecting pane.toolKind — works under shell-wrap", async () => {
    // [LAW:types-are-the-program] The prior shape gated running on
    // pane.toolKind === expected, which is false under default-shell
    // wrapping. spawnLaunch no longer asks; new-session's ack is the
    // signal. This test pins that property: the spawn does NOT consult
    // any topology snapshot, so even a "wrapped" pane (toolKind unknown,
    // currentCommand reporting the wrapper) cannot prevent the
    // transition.
    const { client } = fakeClient({
      "has-session": { throws: "can't find session: feature-x" },
      "new-session": { success: true, output: [] },
      "list-panes": { success: true, output: [`${PANE}|${SESS}|${WIN}`] },
    });
    const result = await spawnLaunch(
      {
        registry: makeRegistry(),
        execute: (cmd: string) => client.execute(cmd),
        getProxyPort: () => 53991,
        newLaunchId: () => "L-wrap" as LaunchId,
      },
      commonSpec(),
    );
    expect(result.status).toBe("running");
    expect(result.launchId).toBe("L-wrap");
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
