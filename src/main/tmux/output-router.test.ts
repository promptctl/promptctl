// @vitest-environment node
//
// Unit tests for TmuxOutputRouter. The router is constructed with fake deps
// that capture event handlers and expose hooks to fire canned events; the
// underlying TmuxClient is faked too. We never spawn a real tmux process
// here — the integration test (output-router.integration.test.ts) covers
// that against a live server.
//
// Coverage focus per ticket 77e.1.4:
//   - Subscribe triggers scrollback capture + streaming state.
//   - Output bytes forwarded only to pane watchers.
//   - Pause → auto-resume + state marker.
//   - Continue → state marker.
//   - Unsubscribe stops delivery.
//   - WebContents destroyed during subscription cleans up.
//   - Connection-state transitions broadcast disconnected / re-capture.

import { describe, expect, it } from "vitest";
import type { TmuxEventMap } from "tmux-control-mode-js";
import type { CommandResponse } from "tmux-control-mode-js/protocol";
import type { ConnectionStateEvent } from "./control";
import { TmuxOutputRouter, type OutputRouterDeps } from "./output-router";
import type { PaneId } from "../../shared/types";
import type { WebContentsLike } from "./output-router";

// Minimal fake WebContents — captures sends and supports destroy simulation.
interface FakeWebContents {
  sent: { channel: string; payload: unknown }[];
  destroyed: boolean;
  destroyListeners: Set<() => void>;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
  destroy(): void;
}

function makeFakeWc(): FakeWebContents {
  const wc: FakeWebContents = {
    sent: [],
    destroyed: false,
    destroyListeners: new Set(),
    send(channel: string, payload: unknown) {
      wc.sent.push({ channel, payload });
    },
    once(event: "destroyed", listener: () => void) {
      wc.destroyListeners.add(listener);
    },
    removeListener(event: "destroyed", listener: () => void) {
      wc.destroyListeners.delete(listener);
    },
    isDestroyed() {
      return wc.destroyed;
    },
    destroy() {
      wc.destroyed = true;
      for (const l of wc.destroyListeners) l();
      wc.destroyListeners.clear();
    },
  };
  return wc;
}

interface Harness {
  router: TmuxOutputRouter;
  fireConnState: (s: ConnectionStateEvent) => void;
  fireEvent: <K extends keyof TmuxEventMap>(
    event: K,
    payload: TmuxEventMap[K],
  ) => void;
  client: {
    executeCalls: string[];
    setPaneActionCalls: [number, string][];
    execute(command: string): Promise<CommandResponse>;
    setPaneAction(paneId: number, action: string): Promise<CommandResponse>;
  };
  setCaptureOutput: (lines: string[]) => void;
  makeWc: () => FakeWebContents;
}

function makeHarness(): Harness {
  const eventHandlers = new Map<keyof TmuxEventMap, ((ev: unknown) => void)[]>();
  const stateListeners = new Set<(s: ConnectionStateEvent) => void>();
  const state = { captureOutput: [] as string[] };

  const client = {
    executeCalls: [] as string[],
    setPaneActionCalls: [] as [number, string][],
    async execute(command: string): Promise<CommandResponse> {
      client.executeCalls.push(command);
      return {
        commandNumber: client.executeCalls.length,
        timestamp: 0,
        output: state.captureOutput,
        success: true,
      };
    },
    async setPaneAction(paneId: number, action: string): Promise<CommandResponse> {
      client.setPaneActionCalls.push([paneId, action]);
      return {
        commandNumber: 0,
        timestamp: 0,
        output: [],
        success: true,
      };
    },
  };

  const deps: OutputRouterDeps = {
    onEvent<K extends keyof TmuxEventMap>(
      event: K,
      handler: (ev: TmuxEventMap[K]) => void,
    ): () => void {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler as (ev: unknown) => void);
      eventHandlers.set(event, list);
      return () => {
        const current = eventHandlers.get(event) ?? [];
        const idx = current.indexOf(handler as (ev: unknown) => void);
        if (idx >= 0) current.splice(idx, 1);
      };
    },
    onConnectionState(listener) {
      stateListeners.add(listener);
      listener({ status: "connecting", reconnectAttempts: 0 });
      return () => stateListeners.delete(listener);
    },
    getClient() {
      return client;
    },
  };

  const router = new TmuxOutputRouter(deps);

  return {
    router,
    fireConnState(s) {
      for (const l of stateListeners) l(s);
    },
    fireEvent(event, payload) {
      const list = eventHandlers.get(event) ?? [];
      for (const h of list) h(payload as never);
    },
    client,
    setCaptureOutput(lines: string[]) {
      state.captureOutput = lines;
    },
    makeWc: makeFakeWc,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const encoder = new TextEncoder();

describe("TmuxOutputRouter", () => {
  it("captures scrollback on first subscribe and sends streaming state", async () => {
    const h = makeHarness();
    h.setCaptureOutput([
      "line1",
      "line2",
      "line3",
    ]);
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    const wc = h.makeWc();

    h.router.subscribe("%1" as PaneId, wc as unknown as WebContentsLike);
    await flush();

    // capture-pane command was issued.
    expect(h.client.executeCalls).toHaveLength(1);
    expect(h.client.executeCalls[0]).toContain("capture-pane");
    expect(h.client.executeCalls[0]).toContain("%1");

    // Scrollback sent as a chunk, followed by streaming state.
    const chunks = wc.sent.filter((s) => s.channel === "tmux:output:chunk");
    const states = wc.sent.filter((s) => s.channel === "tmux:output:state");
    expect(chunks).toHaveLength(1);
    expect((chunks[0].payload as { data: string }).data).toBe(
      "line1\nline2\nline3",
    );
    expect(states).toHaveLength(1);
    expect((states[0].payload as { state: string }).state).toBe("streaming");
  });

  it("forwards output bytes only to watchers of that pane", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc1 = h.makeWc();
    const wc2 = h.makeWc();

    h.router.subscribe("%1" as PaneId, wc1 as unknown as WebContentsLike);
    h.router.subscribe("%2" as PaneId, wc2 as unknown as WebContentsLike);
    await flush();
    wc1.sent.length = 0;
    wc2.sent.length = 0;

    // Output for pane %1 goes only to wc1.
    h.fireEvent("output", {
      type: "output",
      paneId: 1,
      data: encoder.encode("hello pane 1"),
    });

    expect(wc1.sent).toHaveLength(1);
    expect(wc1.sent[0].channel).toBe("tmux:output:chunk");
    expect((wc1.sent[0].payload as { data: string }).data).toBe("hello pane 1");
    expect(wc2.sent).toHaveLength(0);

    // Output for pane %2 goes only to wc2.
    h.fireEvent("output", {
      type: "output",
      paneId: 2,
      data: encoder.encode("hello pane 2"),
    });

    expect(wc2.sent).toHaveLength(1);
    expect((wc2.sent[0].payload as { data: string }).data).toBe("hello pane 2");
  });

  it("forwards extended-output the same as output", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    h.router.subscribe("%5" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    wc.sent.length = 0;

    h.fireEvent("extended-output", {
      type: "extended-output",
      paneId: 5,
      age: 0,
      data: encoder.encode("extended data"),
    });

    expect(wc.sent).toHaveLength(1);
    expect((wc.sent[0].payload as { data: string }).data).toBe("extended data");
  });

  it("auto-resumes and sends paused state on pause event", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    h.router.subscribe("%3" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    wc.sent.length = 0;

    h.fireEvent("pause", { type: "pause", paneId: 3 });

    // State marker sent.
    const states = wc.sent.filter((s) => s.channel === "tmux:output:state");
    expect(states).toHaveLength(1);
    expect((states[0].payload as { state: string }).state).toBe("paused");

    // Auto-resume command issued.
    expect(h.client.setPaneActionCalls).toHaveLength(1);
    expect(h.client.setPaneActionCalls[0]).toEqual([3, "continue"]);
  });

  it("sends streaming state on continue event", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    h.router.subscribe("%3" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    wc.sent.length = 0;

    h.fireEvent("continue", { type: "continue", paneId: 3 });

    const states = wc.sent.filter((s) => s.channel === "tmux:output:state");
    expect(states).toHaveLength(1);
    expect((states[0].payload as { state: string }).state).toBe("streaming");
  });

  it("stops delivery after unsubscribe", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    const wcRef = wc as unknown as WebContentsLike;
    h.router.subscribe("%1" as PaneId, wcRef);
    await flush();
    wc.sent.length = 0;

    h.router.unsubscribe("%1" as PaneId, wcRef);

    h.fireEvent("output", {
      type: "output",
      paneId: 1,
      data: encoder.encode("should not arrive"),
    });

    expect(wc.sent).toHaveLength(0);
  });

  it("cleans up when WebContents is destroyed", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    h.router.subscribe("%1" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    wc.sent.length = 0;

    // Simulate WebContents destruction.
    wc.destroy();

    h.fireEvent("output", {
      type: "output",
      paneId: 1,
      data: encoder.encode("should not arrive"),
    });

    expect(wc.sent).toHaveLength(0);
  });

  it("broadcasts disconnected on non-ready connection state", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    h.router.subscribe("%1" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    wc.sent.length = 0;

    h.fireConnState({
      status: "closed",
      reason: "transport closed",
      reconnectAttempts: 1,
    });

    const states = wc.sent.filter((s) => s.channel === "tmux:output:state");
    expect(states).toHaveLength(1);
    expect((states[0].payload as { state: string }).state).toBe("disconnected");
  });

  it("re-captures scrollback on reconnect for existing watchers", async () => {
    const h = makeHarness();
    h.setCaptureOutput(["old"]);
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    const wc = h.makeWc();
    h.router.subscribe("%1" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    const captureCallsAfterFirst = h.client.executeCalls.length;

    h.fireConnState({
      status: "closed",
      reason: "drop",
      reconnectAttempts: 1,
    });
    h.setCaptureOutput(["reconnected"]);
    h.fireConnState({ status: "ready", reconnectAttempts: 1 });
    await flush();

    // A second capture-pane was issued.
    expect(h.client.executeCalls.length).toBe(captureCallsAfterFirst + 1);
  });

  it("dispose removes all listeners and stops delivery", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc = h.makeWc();
    h.router.subscribe("%1" as PaneId, wc as unknown as WebContentsLike);
    await flush();
    wc.sent.length = 0;

    h.router.dispose();

    h.fireEvent("output", {
      type: "output",
      paneId: 1,
      data: encoder.encode("post-dispose"),
    });

    expect(wc.sent).toHaveLength(0);
  });

  it("delivers to multiple watchers of the same pane", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc1 = h.makeWc();
    const wc2 = h.makeWc();
    h.router.subscribe("%1" as PaneId, wc1 as unknown as WebContentsLike);
    h.router.subscribe("%1" as PaneId, wc2 as unknown as WebContentsLike);
    await flush();
    wc1.sent.length = 0;
    wc2.sent.length = 0;

    h.fireEvent("output", {
      type: "output",
      paneId: 1,
      data: encoder.encode("broadcast"),
    });

    expect(wc1.sent).toHaveLength(1);
    expect(wc2.sent).toHaveLength(1);
  });

  it("skips delivery to destroyed WebContents", async () => {
    const h = makeHarness();
    h.fireConnState({ status: "ready", reconnectAttempts: 0 });
    h.setCaptureOutput([]);
    const wc1 = h.makeWc();
    const wc2 = h.makeWc();
    h.router.subscribe("%1" as PaneId, wc1 as unknown as WebContentsLike);
    h.router.subscribe("%1" as PaneId, wc2 as unknown as WebContentsLike);
    await flush();
    wc1.sent.length = 0;
    wc2.sent.length = 0;

    // Destroy wc1 but don't go through the unsubscribe path.
    wc1.destroyed = true;

    h.fireEvent("output", {
      type: "output",
      paneId: 1,
      data: encoder.encode("only to wc2"),
    });

    // wc1 got nothing (isDestroyed returned true), wc2 got the chunk.
    expect(wc1.sent).toHaveLength(0);
    expect(wc2.sent).toHaveLength(1);
  });
});
