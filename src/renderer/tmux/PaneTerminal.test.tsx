// [LAW:behavior-not-structure] These tests assert the contract of
// PaneTerminal: chunks for the active pane land in xterm's parser/buffer;
// keystrokes flow back to tmux.sendKeys with the right target. They read
// xterm's public buffer API (`buffer.active.getLine`) rather than DOM
// internals — same contract the e2e suite asserts against the live app.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { installElectronMock, setInvokeHandlers } from "../../test/electron-mock";
import type { PaneId, TmuxOutputChunk } from "../../shared/types";
import type * as proxyModule from "./proxy";
import { PaneTerminal } from "./PaneTerminal";

// xterm.js touches DOM measurement APIs that JSDOM does not implement.
// Stubbing them here keeps the component's first-render path from throwing.
beforeAll(() => {
  const noop = (): void => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe = noop;
      unobserve = noop;
      disconnect = noop;
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }
  if (typeof window.matchMedia === "undefined") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        media: "",
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop,
        dispatchEvent: () => false,
        onchange: null,
      }),
    });
  }
});

const PANE_A = "%1" as PaneId;
const PANE_B = "%2" as PaneId;

const sendKeysSpy = vi.fn(async () => undefined);
const setSizeSpy = vi.fn(async () => undefined);

vi.mock("./proxy", async () => {
  const actual = await vi.importActual<typeof proxyModule>("./proxy");
  return {
    ...actual,
    getTmuxProxy: () => ({
      sendKeys: sendKeysSpy,
      setSize: setSizeSpy,
    }),
  };
});

function chunk(paneId: PaneId, data: string): TmuxOutputChunk {
  return { paneId, data };
}

function readBufferLine(index: number): string {
  const handle = window.__paneTerminal;
  if (handle === undefined) throw new Error("paneTerminal global not set");
  const line = handle.terminal.buffer.active.getLine(index);
  if (line === undefined) throw new Error(`line ${index} missing`);
  return line.translateToString(true /* trimRight */);
}

// xterm batches writes through a WriteBuffer that flushes via setTimeout(0).
// `terminal.write("", cb)` invokes `cb` once the buffer drains; queuing it
// after the chunk-event handler's write guarantees the prior data is in
// the parser by the time the callback fires (FIFO ordering).
async function flushPendingWrites(): Promise<void> {
  const handle = window.__paneTerminal;
  if (handle === undefined) throw new Error("paneTerminal global not set");
  await new Promise<void>((resolve) => {
    handle.terminal.write("", () => resolve());
  });
}

beforeEach(() => {
  sendKeysSpy.mockClear();
  setSizeSpy.mockClear();
  const api = installElectronMock();
  // [LAW:single-enforcer] tmuxIpc is read by getTmuxProxy() — stub it so the
  // bridge construction path doesn't reach into a nonexistent global.
  // The mocked getTmuxProxy() above bypasses createRendererBridge entirely,
  // so the contents of tmuxIpc here are irrelevant.
  (window as unknown as { tmuxIpc: unknown }).tmuxIpc = {
    invoke: async () => undefined,
    send: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  };
  setInvokeHandlers(api, {
    "tmux:output:subscribe": () => undefined,
    "tmux:output:unsubscribe": () => undefined,
  });
});

afterEach(() => {
  delete (window as { __paneTerminal?: unknown }).__paneTerminal;
});

describe("PaneTerminal", () => {
  it("writes plain bytes for the active pane into xterm's buffer", async () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:output:subscribe": () => undefined,
      "tmux:output:unsubscribe": () => undefined,
    });

    render(<PaneTerminal paneId={PANE_A} />);

    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_A, "hello world\r\n"));
    });

    await flushPendingWrites();
    expect(readBufferLine(0)).toContain("hello world");
  });

  it("renders ANSI cursor moves and color escapes through the parser", async () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:output:subscribe": () => undefined,
      "tmux:output:unsubscribe": () => undefined,
    });

    render(<PaneTerminal paneId={PANE_A} />);

    // Send a red "ERR", carriage-return + line feed, then a green "OK".
    // Foreground colors are 31 (red) and 32 (green); the SGR reset is 0.
    const ansi = "\x1b[31mERR\x1b[0m\r\n\x1b[32mOK\x1b[0m";
    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_A, ansi));
    });

    await flushPendingWrites();

    expect(readBufferLine(0)).toContain("ERR");
    expect(readBufferLine(1)).toContain("OK");

    // Foreground color attribute on row 0 col 0 reflects the SGR 31 prefix.
    const handle = window.__paneTerminal;
    if (handle === undefined) throw new Error("paneTerminal global not set");
    const line0 = handle.terminal.buffer.active.getLine(0);
    if (line0 === undefined) throw new Error("line 0 missing");
    const cell0 = line0.getCell(0);
    if (cell0 === undefined) throw new Error("cell 0 missing");
    // ANSI standard color index 1 == red.
    expect(cell0.isFgPalette()).toBe(true);
    expect(cell0.getFgColor()).toBe(1);
  });

  it("ignores chunks addressed to a different pane", async () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:output:subscribe": () => undefined,
      "tmux:output:unsubscribe": () => undefined,
    });

    render(<PaneTerminal paneId={PANE_A} />);

    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_B, "leaked\r\n"));
    });

    await flushPendingWrites();
    expect(readBufferLine(0)).toBe("");
  });

  it("calls tmux.output:subscribe on mount and unsubscribe on unmount", () => {
    const api = installElectronMock();
    const subscribe = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(async () => undefined);
    setInvokeHandlers(api, {
      "tmux:output:subscribe": subscribe,
      "tmux:output:unsubscribe": unsubscribe,
    });

    const { unmount } = render(<PaneTerminal paneId={PANE_A} />);
    expect(subscribe).toHaveBeenCalledWith(PANE_A);

    unmount();
    expect(unsubscribe).toHaveBeenCalledWith(PANE_A);
  });
});

describe("PaneTerminal — keystroke round-trip", () => {
  it("forwards user input through tmux.sendKeys with the active paneId", () => {
    render(<PaneTerminal paneId={PANE_A} />);

    const handle = window.__paneTerminal;
    if (handle === undefined) throw new Error("paneTerminal global not set");

    // Drive the onData hook directly via xterm's `paste` helper. paste()
    // routes through the same _onData handler keystrokes use, so this is
    // the public API surface for "data entered by the user."
    handle.terminal.paste("ls -la\r");

    expect(sendKeysSpy).toHaveBeenCalledTimes(1);
    expect(sendKeysSpy).toHaveBeenCalledWith(PANE_A, "ls -la\r");
  });
});
