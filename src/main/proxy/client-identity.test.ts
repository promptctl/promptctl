// @vitest-environment node
import { describe, expect, it } from "vitest";
import type http from "node:http";
import type net from "node:net";
import {
  clientInfoFromLaunch,
  parseLsofEntries,
  parseLsofPid,
  parseLsofPids,
  readLaunchHeader,
  resolveClientId,
  walkToClientRoot,
  type ProcessRow,
} from "./client-identity";
import type { Launch, LaunchId } from "../../shared/types";

describe("client identity parsers", () => {
  it("parses lsof field output into a pid", () => {
    expect(parseLsofPid("p12345\nn127.0.0.1:54321\n")).toBe(12345);
  });

  it("returns null when lsof has no process field", () => {
    expect(parseLsofPid("n127.0.0.1:54321\n")).toBeNull();
  });

  it("parses all lsof process fields in output order", () => {
    expect(parseLsofPids("p111\nnA\np222\nnB\n")).toEqual([111, 222]);
  });

  it("parses lsof pid/name pairs", () => {
    expect(
      parseLsofEntries("p111\nn127.0.0.1:1->127.0.0.1:2\np222\nnB\n"),
    ).toEqual([
      { pid: 111, name: "127.0.0.1:1->127.0.0.1:2" },
      { pid: 222, name: "B" },
    ]);
  });
});

describe("walkToClientRoot", () => {
  // Build a reader from a flat process table for the tests.
  const readerFor = (rows: ProcessRow[]) => async (pid: number) => {
    const row = rows.find((r) => r.pid === pid);
    if (!row) throw new Error(`no such pid ${pid}`);
    return row;
  };

  it("returns the start pid when its parent is already a shell", async () => {
    // claude(2000) ← bash(1900) ← tmux(1800) ← launchd(1)
    // Walk should stop at claude because its parent (bash) is a shell.
    const reader = readerFor([
      { pid: 2000, ppid: 1900, comm: "claude" },
      { pid: 1900, ppid: 1800, comm: "bash" },
      { pid: 1800, ppid: 1, comm: "tmux" },
    ]);
    const root = await walkToClientRoot(2000, reader);
    expect(root.pid).toBe(2000);
    expect(root.comm).toBe("claude");
  });

  it("walks up through non-shell ancestors", async () => {
    // node(3000) ← node(2900) ← claude(2800) ← zsh(1900)
    // Walk from 3000 should stop at 2800 (claude), since its parent zsh is a shell.
    const reader = readerFor([
      { pid: 3000, ppid: 2900, comm: "node" },
      { pid: 2900, ppid: 2800, comm: "node" },
      { pid: 2800, ppid: 1900, comm: "claude" },
      { pid: 1900, ppid: 1, comm: "zsh" },
    ]);
    const root = await walkToClientRoot(3000, reader);
    expect(root.pid).toBe(2800);
    expect(root.comm).toBe("claude");
  });

  it("two descendants of the same launched program converge on one root", async () => {
    // Both 4001 and 4002 are children of claude(4000); claude's parent is bash.
    // The walk should produce the same root for both, regardless of which one
    // we start from. This is the property that makes per-launch tab coalescing
    // work — multiple sockets from the same logical client land on one clientId.
    const reader = readerFor([
      { pid: 4001, ppid: 4000, comm: "node" },
      { pid: 4002, ppid: 4000, comm: "node" },
      { pid: 4000, ppid: 1900, comm: "claude" },
      { pid: 1900, ppid: 1, comm: "bash" },
    ]);
    const r1 = await walkToClientRoot(4001, reader);
    const r2 = await walkToClientRoot(4002, reader);
    expect(r1.pid).toBe(r2.pid);
    expect(r1.pid).toBe(4000);
  });

  it("stops at ppid <= 1 even with no shell in the chain", async () => {
    // Some kernel-launched daemons have init/launchd as their direct parent.
    const reader = readerFor([{ pid: 5000, ppid: 1, comm: "weirdd" }]);
    const root = await walkToClientRoot(5000, reader);
    expect(root.pid).toBe(5000);
  });

  it("stops gracefully when an ancestor row disappears mid-walk", async () => {
    // ppid 9999 is missing from the table — simulates a parent that exited
    // between two ps reads. The walk returns the last known good row instead
    // of crashing.
    const reader = readerFor([{ pid: 6000, ppid: 9999, comm: "claude" }]);
    const root = await walkToClientRoot(6000, reader);
    expect(root.pid).toBe(6000);
  });

  it("treats tmux/login/sshd/launchd/init as walk stoppers", async () => {
    for (const stopper of [
      "tmux",
      "login",
      "sshd",
      "launchd",
      "init",
      "screen",
    ]) {
      const reader = readerFor([
        { pid: 7000, ppid: 6000, comm: "claude" },
        { pid: 6000, ppid: 1, comm: stopper },
      ]);
      const root = await walkToClientRoot(7000, reader);
      expect(root.pid, `walk should stop before ${stopper}`).toBe(7000);
    }
  });
});

describe("readLaunchHeader", () => {
  function req(headers: http.IncomingHttpHeaders): http.IncomingMessage {
    return { headers } as unknown as http.IncomingMessage;
  }
  it("returns the trimmed launchId when present", () => {
    expect(readLaunchHeader(req({ "x-promptctl-launch": "abc-123" }))).toBe(
      "abc-123",
    );
  });
  it("returns null when absent", () => {
    expect(readLaunchHeader(req({}))).toBeNull();
  });
  it("returns null on empty / whitespace value", () => {
    expect(readLaunchHeader(req({ "x-promptctl-launch": "   " }))).toBeNull();
  });
  it("returns the first value when the header is repeated", () => {
    expect(
      readLaunchHeader(req({ "x-promptctl-launch": ["first", "second"] })),
    ).toBe("first");
  });
});

describe("clientInfoFromLaunch", () => {
  function makeLaunch(overrides: Partial<Launch> = {}): Launch {
    return {
      launchId: "L-1" as LaunchId,
      toolKind: "claude",
      paneId: "%17" as never,
      sessionId: "$3" as never,
      windowId: "@5" as never,
      cwd: "/repo/foo",
      startedAt: 1,
      env: {},
      status: "running",
      pid: 1234,
      proxyClientId: null,
      sessionFilePath: null,
      ...overrides,
    } as Launch;
  }

  it("builds a ClientInfo with stable clientId, launchId, and pid", () => {
    const info = clientInfoFromLaunch(makeLaunch());
    expect(info.clientId).toBe("launch-L-1");
    expect(info.launchId).toBe("L-1");
    expect(info.pid).toBe(1234);
    expect(info.rootPid).toBe(1234);
    expect(info.command).toBe("claude");
    expect(info.cwd).toBe("/repo/foo");
    expect(info.displayName).toBe("claude @ foo");
  });

  it("uses 'unknown cwd' when launch cwd is empty", () => {
    expect(clientInfoFromLaunch(makeLaunch({ cwd: "" })).displayName).toBe(
      "claude @ unknown cwd",
    );
  });

  it("returns null pid for pending launches", () => {
    const pending: Launch = {
      launchId: "P" as LaunchId,
      toolKind: "claude",
      paneId: "%17" as never,
      sessionId: "$3" as never,
      windowId: "@5" as never,
      cwd: "/repo",
      startedAt: 1,
      env: {},
      status: "pending",
    };
    expect(clientInfoFromLaunch(pending).pid).toBeNull();
  });
});

describe("resolveClientId", () => {
  function req(headers: http.IncomingHttpHeaders): http.IncomingMessage {
    return { headers } as unknown as http.IncomingMessage;
  }
  function socket(): net.Socket {
    // resolveClientId only delegates to the socket fallback when the
    // header path doesn't hit; we just need a placeholder.
    return { remotePort: 0 } as unknown as net.Socket;
  }
  function makeLaunch(): Launch {
    return {
      launchId: "L-1" as LaunchId,
      toolKind: "claude",
      paneId: "%17" as never,
      sessionId: "$3" as never,
      windowId: "@5" as never,
      cwd: "/repo",
      startedAt: 1,
      env: {},
      status: "running",
      pid: 100,
      proxyClientId: null,
      sessionFilePath: null,
    };
  }

  it("returns launch-derived ClientInfo when the header matches a known launch", async () => {
    const launch = makeLaunch();
    const info = await resolveClientId(
      req({ "x-promptctl-launch": "L-1" }),
      socket(),
      (id) => (id === ("L-1" as LaunchId) ? launch : null),
    );
    expect(info.launchId).toBe("L-1");
    expect(info.clientId).toBe("launch-L-1");
  });

  it("falls back to the socket resolver when the header is absent", async () => {
    let fallbackCalls = 0;
    const stub = async (_s: unknown) => {
      fallbackCalls += 1;
      return {
        clientId: "stub-fallback",
        pid: 100,
        rootPid: 100,
        displayName: "stub",
        command: null,
        cwd: null,
        lastSeenNs: 0,
        launchId: null,
      } as const;
    };
    const info = await resolveClientId(
      req({}),
      socket(),
      () => null,
      stub,
    );
    expect(fallbackCalls).toBe(1);
    expect(info.clientId).toBe("stub-fallback");
    expect(info.launchId).toBeNull();
  });

  it("falls back to the socket resolver when the header references an unknown launch", async () => {
    let fallbackCalls = 0;
    const stub = async () => {
      fallbackCalls += 1;
      return {
        clientId: "stub-fallback",
        pid: null,
        rootPid: null,
        displayName: "stub",
        command: null,
        cwd: null,
        lastSeenNs: 0,
        launchId: null,
      } as const;
    };
    await resolveClientId(
      req({ "x-promptctl-launch": "unknown" }),
      socket(),
      () => null,
      stub,
    );
    expect(fallbackCalls).toBe(1);
  });

  it("does NOT invoke the fallback when the header matches a known launch", async () => {
    let fallbackCalls = 0;
    const stub = async () => {
      fallbackCalls += 1;
      throw new Error("should not be called");
    };
    const launch = makeLaunch();
    const info = await resolveClientId(
      req({ "x-promptctl-launch": "L-1" }),
      socket(),
      (id) => (id === ("L-1" as LaunchId) ? launch : null),
      stub,
    );
    expect(fallbackCalls).toBe(0);
    expect(info.clientId).toBe("launch-L-1");
  });
});
