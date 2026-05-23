// @vitest-environment node
//
// Unit tests for TmuxControlConnection. Uses a hand-rolled fake transport
// that lets the test drive both directions of the protocol — outbound
// commands captured for assertion, inbound %begin/%end framing scripted
// to resolve the library's pending-promise machinery deterministically.
//
// The connection's mesh shape (one client per observed session) means tests
// often spawn multiple transports keyed by target. `FakeTransportRegistry`
// below is the test-side companion to the factory's `(target) => transport`
// signature — it builds the next transport on demand for any target the
// connection requests, so test setup describes *what sessions are observed*
// rather than juggling transport pools manually.

import { afterEach, describe, expect, it } from "vitest";
import {
  TmuxControlConnection,
  type ConnectionStateEvent,
} from "./control";
import type { TmuxTransport } from "tmux-control-mode-js";
import type { SessionId } from "../../shared/types";

class FakeTransport implements TmuxTransport {
  readonly sent: string[] = [];
  private dataCb: ((chunk: string) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  closed = false;

  send(command: string): void {
    this.sent.push(command);
  }
  onData(cb: (chunk: string) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed = true;
    this.closeCb?.("transport closed by test");
  }

  feed(chunk: string): void {
    if (!this.dataCb) throw new Error("test attempted to feed before client wired up");
    this.dataCb(chunk);
  }

  // Resolve the most-recent in-flight command by sending a matching %begin/%end.
  ack(commandNumber: number): void {
    const t = Date.now();
    this.feed(`%begin ${t} ${commandNumber} 0\n`);
    this.feed(`%end ${t} ${commandNumber} 0\n`);
  }

  externalDrop(reason = "tmux server died"): void {
    this.closeCb?.(reason);
  }
}

// [LAW:single-enforcer] FIFO queue of transports built per target. Each
// `waitFor(target)` call consumes one entry — the *next* transport the
// connection spawns for that target, not whichever one is currently latest.
// That makes reconnect tests describable as a sequence of "now expect a
// fresh transport" calls without bookkeeping local variables that race
// against the underlying spawn.
class FakeTransportRegistry {
  private readonly available = new Map<string, FakeTransport[]>();
  private readonly waiters = new Map<string, ((t: FakeTransport) => void)[]>();
  // Cumulative count of builds per target — used by tests to assert a
  // session was NOT respawned (e.g. idempotent observeSessions).
  readonly buildCounts = new Map<string, number>();

  // Called by the connection (via factory) — returns a fresh transport so
  // reconnects get a new instance per attempt.
  build(target: string): FakeTransport {
    this.buildCounts.set(target, (this.buildCounts.get(target) ?? 0) + 1);
    const fresh = new FakeTransport();
    const w = this.waiters.get(target);
    if (w !== undefined && w.length > 0) {
      const resolve = w.shift();
      if (w.length === 0) this.waiters.delete(target);
      resolve?.(fresh);
      return fresh;
    }
    const queue = this.available.get(target) ?? [];
    queue.push(fresh);
    this.available.set(target, queue);
    return fresh;
  }

  // Consume the next transport built for `target`, waiting for it to appear
  // if necessary. Each call returns a distinct transport — calling twice
  // pairs naturally with reconnect ("initial, then after-drop").
  waitFor(target: string, timeoutMs = 500): Promise<FakeTransport> {
    const queue = this.available.get(target);
    if (queue !== undefined && queue.length > 0) {
      const t = queue.shift();
      if (queue.length === 0) this.available.delete(target);
      if (t !== undefined) return Promise.resolve(t);
    }
    return new Promise<FakeTransport>((resolve, reject) => {
      const timer = setTimeout(() => {
        const w = this.waiters.get(target);
        if (w !== undefined) {
          const idx = w.indexOf(wrapped);
          if (idx >= 0) w.splice(idx, 1);
        }
        reject(new Error(`waitFor(${target}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = (t: FakeTransport): void => {
        clearTimeout(timer);
        resolve(t);
      };
      const list = this.waiters.get(target) ?? [];
      list.push(wrapped);
      this.waiters.set(target, list);
    });
  }
}

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("TmuxControlConnection", () => {
  it("enters ready after server probe + setFlags resolve (attach is via argv)", async () => {
    const registry = new FakeTransportRegistry();
    const states: ConnectionStateEvent[] = [];

    const conn = TmuxControlConnection.start({
      transportFactory: (target) => registry.build(target),
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 50,
    });
    conn.onConnectionState((ev) => states.push(ev));

    const primary = await registry.waitFor("promptctl-test");
    await waitFor(() => primary.sent.length > 0);
    expect(primary.sent[0]).toBe("refresh-client -f pause-after=2\n");

    primary.ack(1);
    await conn.ready;

    expect(conn.getState().status).toBe("ready");
    expect(states.map((s) => s.status)).toContain("ready");
    // No switch-client — primary's attach-session is in the argv.
    expect(primary.sent.length).toBe(1);
  });

  it("re-registers subscriptions on reconnect", async () => {
    const registry = new FakeTransportRegistry();
    const conn = TmuxControlConnection.start({
      transportFactory: (target) => registry.build(target),
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 10,
    });

    const events: number[] = [];
    conn.on("window-add", (ev) => events.push(ev.windowId));

    const t1 = await registry.waitFor("promptctl-test");
    await waitFor(() => t1.sent.length > 0);
    t1.ack(1);
    await conn.ready;

    t1.feed("%window-add @42\n");
    expect(events).toEqual([42]);

    t1.externalDrop();

    const t2 = await registry.waitFor("promptctl-test", 1000);
    await waitFor(() => t2.sent.length > 0, 1000);
    t2.ack(1);
    await waitFor(() => conn.getState().status === "ready");

    t2.feed("%window-add @99\n");
    expect(events).toEqual([42, 99]);
  });

  it("schedules reconnect when bootstrap fails on the first attempt", async () => {
    let bootstraps = 0;
    const registry = new FakeTransportRegistry();
    const conn = TmuxControlConnection.start({
      sessionName: "promptctl-test",
      transportFactory: (target) => registry.build(target),
      bootstrap: async () => {
        bootstraps += 1;
        if (bootstraps < 2) throw new Error("no tmux");
      },
      reconnectDelayMs: 30,
    });

    await waitFor(() => bootstraps >= 2, 1000);
    const transport = await registry.waitFor("promptctl-test", 1000);
    await waitFor(() => transport.sent.length > 0, 1000);
    expect(conn.getState().status).toBe("connecting");

    transport.ack(1);
    await conn.ready;
    expect(conn.getState().status).toBe("ready");
  });

  it("close() halts reconnect attempts", async () => {
    let factoryCalls = 0;
    const conn = TmuxControlConnection.start({
      transportFactory: (_target) => {
        factoryCalls += 1;
        return new FakeTransport();
      },
      sessionName: "promptctl-test",
      bootstrap: async () => { throw new Error("no tmux"); },
      reconnectDelayMs: 10,
    });

    await waitFor(() => factoryCalls === 0 && conn.getState().status === "closed", 500);
    conn.close();
    const before = factoryCalls;
    await delay(60);
    expect(factoryCalls).toBe(before);
  });

  it("unsubscribe removes the listener from re-registration set", async () => {
    const registry = new FakeTransportRegistry();
    const conn = TmuxControlConnection.start({
      transportFactory: (target) => registry.build(target),
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 10,
    });

    const seen: number[] = [];
    const off = conn.on("window-add", (ev) => seen.push(ev.windowId));

    const t1 = await registry.waitFor("promptctl-test");
    await waitFor(() => t1.sent.length > 0);
    t1.ack(1);
    await conn.ready;

    off();
    t1.externalDrop();

    const t2 = await registry.waitFor("promptctl-test", 1000);
    await waitFor(() => t2.sent.length > 0, 1000);
    t2.ack(1);
    await waitFor(() => conn.getState().status === "ready");

    t2.feed("%window-add @7\n");
    expect(seen).toEqual([]);
  });

  describe("observeSessions (follower mesh)", () => {
    it("spawns a follower per observed session attached by id", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      conn.observeSessions(
        new Set<SessionId>(["$3", "$5"] as SessionId[]),
      );

      const follower3 = await registry.waitFor("$3");
      const follower5 = await registry.waitFor("$5");

      // Each follower's first outbound command is setFlags pause-after=2 —
      // the spawn is otherwise self-driven (attach is via argv).
      await waitFor(() => follower3.sent.length > 0);
      await waitFor(() => follower5.sent.length > 0);
      expect(follower3.sent[0]).toBe("refresh-client -f pause-after=2\n");
      expect(follower5.sent[0]).toBe("refresh-client -f pause-after=2\n");
    });

    it("is idempotent — same set of observations does not respawn", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      const target = new Set<SessionId>(["$7"] as SessionId[]);
      conn.observeSessions(target);
      const follower7a = await registry.waitFor("$7");
      await waitFor(() => follower7a.sent.length > 0);
      follower7a.ack(1);

      // Same set again — no new transport built.
      conn.observeSessions(target);
      await delay(20);
      expect(registry.buildCounts.get("$7")).toBe(1);
    });

    it("tears down a follower when its session leaves the observation set", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      conn.observeSessions(new Set<SessionId>(["$9"] as SessionId[]));
      const follower = await registry.waitFor("$9");
      await waitFor(() => follower.sent.length > 0);
      follower.ack(1);
      expect(follower.closed).toBe(false);

      // Empty observation set — the follower must close.
      conn.observeSessions(new Set<SessionId>());
      await waitFor(() => follower.closed === true, 500);
    });

    it("fans session-scoped events from followers to registered handlers", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      const seen: number[] = [];
      conn.on("output", (ev) => seen.push(ev.paneId));

      conn.observeSessions(new Set<SessionId>(["$11"] as SessionId[]));
      const follower = await registry.waitFor("$11");
      await waitFor(() => follower.sent.length > 0);
      follower.ack(1);

      // %output from the follower for a pane in its session must reach the handler.
      follower.feed("%output %42 hello\n");
      expect(seen).toEqual([42]);

      // %output from primary for a pane in the owned session also reaches it.
      primary.feed("%output %7 world\n");
      expect(seen).toEqual([42, 7]);
    });

    it("does NOT fan server-scoped events from followers (only primary emits)", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      const seen: number[] = [];
      conn.on("window-add", (ev) => seen.push(ev.windowId));

      conn.observeSessions(new Set<SessionId>(["$13"] as SessionId[]));
      const follower = await registry.waitFor("$13");
      await waitFor(() => follower.sent.length > 0);
      follower.ack(1);

      // Follower emits a topology event — it must NOT reach the handler
      // (followers are session-scoped only; topology comes from primary).
      follower.feed("%window-add @100\n");
      expect(seen).toEqual([]);

      // Primary's event reaches the handler exactly once.
      primary.feed("%window-add @101\n");
      expect(seen).toEqual([101]);
    });

    it("auto-resumes a follower's paused pane via set-pane-action continue", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      conn.observeSessions(new Set<SessionId>(["$15"] as SessionId[]));
      const follower = await registry.waitFor("$15");
      await waitFor(() => follower.sent.length > 0);
      follower.ack(1); // setFlags ack

      const beforePause = follower.sent.length;
      follower.feed("%pause %88\n");

      // Auto-resume: a set-pane-action continue should be sent on the
      // SAME follower client, not on primary.
      await waitFor(() => follower.sent.length > beforePause, 500);
      expect(follower.sent[beforePause]).toContain("88");
      expect(follower.sent[beforePause]).toContain("continue");
    });

    it("attaches listeners registered before observe to subsequently-spawned followers", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      const seen: number[] = [];
      // Register handler BEFORE observing any foreign session — the spawn
      // path must replay listeners onto the new follower.
      conn.on("output", (ev) => seen.push(ev.paneId));

      conn.observeSessions(new Set<SessionId>(["$17"] as SessionId[]));
      const follower = await registry.waitFor("$17");
      await waitFor(() => follower.sent.length > 0);
      follower.ack(1);

      follower.feed("%output %33 late\n");
      expect(seen).toEqual([33]);
    });

    it("close() tears down primary and every follower", async () => {
      const registry = new FakeTransportRegistry();
      const conn = TmuxControlConnection.start({
        transportFactory: (target) => registry.build(target),
        sessionName: "promptctl-test",
        bootstrap: async () => undefined,
        reconnectDelayMs: 50,
      });

      const primary = await registry.waitFor("promptctl-test");
      await waitFor(() => primary.sent.length > 0);
      primary.ack(1);
      await conn.ready;

      conn.observeSessions(
        new Set<SessionId>(["$19", "$21"] as SessionId[]),
      );
      const f1 = await registry.waitFor("$19");
      const f2 = await registry.waitFor("$21");
      await waitFor(() => f1.sent.length > 0);
      await waitFor(() => f2.sent.length > 0);
      f1.ack(1);
      f2.ack(1);

      conn.close();

      expect(primary.closed).toBe(true);
      expect(f1.closed).toBe(true);
      expect(f2.closed).toBe(true);
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
