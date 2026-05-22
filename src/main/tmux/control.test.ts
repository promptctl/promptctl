// @vitest-environment node
//
// Unit tests for TmuxControlConnection. Uses a hand-rolled fake transport
// that lets the test drive both directions of the protocol — outbound
// commands captured for assertion, inbound %begin/%end framing scripted
// to resolve the library's pending-promise machinery deterministically.

import { afterEach, describe, expect, it } from "vitest";
import {
  TmuxControlConnection,
  type ConnectionStateEvent,
} from "./control";
import type { TmuxTransport } from "tmux-control-mode-js";

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

afterEach(() => {
  TmuxControlConnection.__resetForTesting();
});

describe("TmuxControlConnection", () => {
  it("enters ready after server probe + setFlags + attach resolve", async () => {
    const transport = new FakeTransport();
    const states: ConnectionStateEvent[] = [];

    const conn = TmuxControlConnection.start({
      transportFactory: () => transport,
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 50,
    });
    conn.onConnectionState((ev) => states.push(ev));

    await waitFor(() => transport.sent.length > 0);
    expect(transport.sent[0]).toBe("refresh-client -f pause-after=2\n");

    transport.ack(1);
    // applyWatchedSession attaches the client to the owned session after
    // setFlags; readiness waits on this so the attachment is established first.
    await waitFor(() => transport.sent.length > 1);
    expect(transport.sent[1]).toBe("switch-client -t 'promptctl-test'\n");

    transport.ack(2);
    await conn.ready;

    expect(conn.getState().status).toBe("ready");
    expect(states.map((s) => s.status)).toContain("ready");
  });

  it("watchSession switches the live client to the requested session", async () => {
    const transport = new FakeTransport();
    const conn = TmuxControlConnection.start({
      transportFactory: () => transport,
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 50,
    });

    await waitFor(() => transport.sent.length > 0);
    transport.ack(1); // setFlags
    await waitFor(() => transport.sent.length > 1);
    transport.ack(2); // initial attach to the owned session
    await conn.ready;

    const before = transport.sent.length;
    const watching = conn.watchSession("$3");
    await waitFor(() => transport.sent.length > before);
    expect(transport.sent[before]).toBe("switch-client -t '$3'\n");
    transport.ack(3);
    await watching;
  });

  it("re-applies the watched session after a reconnect", async () => {
    const t1 = new FakeTransport();
    const t2 = new FakeTransport();
    const transports = [t1, t2];

    const conn = TmuxControlConnection.start({
      transportFactory: () => {
        const next = transports.shift();
        if (!next) throw new Error("test exhausted transport pool");
        return next;
      },
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 10,
    });

    await waitFor(() => t1.sent.length > 0);
    t1.ack(1);
    await waitFor(() => t1.sent.length > 1);
    t1.ack(2);
    await conn.ready;

    const watching = conn.watchSession("$5");
    await waitFor(() => t1.sent.length > 2);
    t1.ack(3);
    await watching;

    t1.externalDrop();

    await waitFor(() => t2.sent.length > 0, 1000);
    t2.ack(1); // setFlags on the fresh client
    // The new client must re-attach to the WATCHED session, not the owned one —
    // the renderer never sees the drop, so only the connection can restore it.
    await waitFor(() => t2.sent.length > 1, 1000);
    expect(t2.sent[1]).toBe("switch-client -t '$5'\n");
    t2.ack(2);
    await waitFor(() => conn.getState().status === "ready");
  });

  it("re-registers subscriptions on reconnect", async () => {
    const t1 = new FakeTransport();
    const t2 = new FakeTransport();
    const transports = [t1, t2];

    const conn = TmuxControlConnection.start({
      transportFactory: () => {
        const next = transports.shift();
        if (!next) throw new Error("test exhausted transport pool");
        return next;
      },
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 10,
    });

    const events: number[] = [];
    conn.on("window-add", (ev) => events.push(ev.windowId));

    await waitFor(() => t1.sent.length > 0);
    t1.ack(1);
    await waitFor(() => t1.sent.length > 1);
    t1.ack(2);
    await conn.ready;

    t1.feed("%window-add @42\n");
    expect(events).toEqual([42]);

    t1.externalDrop();

    await waitFor(() => t2.sent.length > 0, 1000);
    t2.ack(1);
    await waitFor(() => t2.sent.length > 1, 1000);
    t2.ack(2);
    await waitFor(() => conn.getState().status === "ready");

    t2.feed("%window-add @99\n");
    expect(events).toEqual([42, 99]);
  });

  it("schedules reconnect when bootstrap fails on the first attempt", async () => {
    let bootstraps = 0;
    const transport = new FakeTransport();
    const conn = TmuxControlConnection.start({
      sessionName: "promptctl-test",
      transportFactory: () => transport,
      bootstrap: async () => {
        bootstraps += 1;
        if (bootstraps < 2) throw new Error("no tmux");
      },
      reconnectDelayMs: 30,
    });

    await waitFor(() => bootstraps >= 2, 1000);
    await waitFor(() => transport.sent.length > 0, 1000);
    expect(conn.getState().status).toBe("connecting");

    transport.ack(1);
    await waitFor(() => transport.sent.length > 1, 1000);
    transport.ack(2);
    await conn.ready;
    expect(conn.getState().status).toBe("ready");
  });

  it("close() halts reconnect attempts", async () => {
    let factoryCalls = 0;
    const conn = TmuxControlConnection.start({
      transportFactory: () => {
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
    const t1 = new FakeTransport();
    const t2 = new FakeTransport();
    const transports = [t1, t2];

    const conn = TmuxControlConnection.start({
      transportFactory: () => {
        const next = transports.shift();
        if (!next) throw new Error("test exhausted transport pool");
        return next;
      },
      sessionName: "promptctl-test",
      bootstrap: async () => undefined,
      reconnectDelayMs: 10,
    });

    const seen: number[] = [];
    const off = conn.on("window-add", (ev) => seen.push(ev.windowId));

    await waitFor(() => t1.sent.length > 0);
    t1.ack(1);
    await waitFor(() => t1.sent.length > 1);
    t1.ack(2);
    await conn.ready;

    off();
    t1.externalDrop();

    await waitFor(() => t2.sent.length > 0, 1000);
    t2.ack(1);
    await waitFor(() => t2.sent.length > 1, 1000);
    t2.ack(2);
    await waitFor(() => conn.getState().status === "ready");

    t2.feed("%window-add @7\n");
    expect(seen).toEqual([]);
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
