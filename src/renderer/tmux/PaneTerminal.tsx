// [LAW:dataflow-not-control-flow] One terminal.write call per chunk,
// unconditional. The active paneId is data: chunks for other panes are
// filtered by value, never gated by branching the work itself off.
//
// [LAW:single-enforcer] All xterm lifecycle (open/dispose/resize) lives
// inside this component. The page that hosts <PaneTerminal /> never reaches
// into the terminal directly — the only seam is the paneId prop.
//
// [LAW:one-source-of-truth] tmux output for the active pane flows through
// `tmux:output:chunk` events (subscription managed via tmux:output:subscribe
// / unsubscribe). Components that want xterm rendering use this; nothing
// else accumulates text from those events for display purposes.

import * as React from "react";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { PaneId, TmuxOutputChunk } from "../../shared/types";
import { getTmuxProxy } from "./proxy";

declare global {
  interface Window {
    // [LAW:no-defensive-null-guards] The global is set on mount, cleared on
    // unmount; consumers (Playwright) read it only after asserting the
    // terminal element is present, so the type can be optional without
    // spreading null-checks across call sites.
    __paneTerminal?: PaneTerminalHandle;
  }
}

export interface PaneTerminalHandle {
  readonly paneId: PaneId;
  readonly terminal: Terminal;
}

interface PaneTerminalProps {
  readonly paneId: PaneId;
}

export function PaneTerminal({ paneId }: PaneTerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono", Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: { background: "#0a0a0a" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);

    // Expose the live terminal so Playwright can read buffer state directly.
    // One pane is rendered at a time on the debug surface, so a singleton
    // suffices; future multi-pane surfaces will move to a registry keyed
    // by paneId.
    window.__paneTerminal = { paneId, terminal };

    const proxy = getTmuxProxy();

    // [LAW:dataflow-not-control-flow] Keystrokes always flow through
    // sendKeys; the library encodes them as `send-keys -l` so the data
    // reaches the pane verbatim, no shell expansion at the tmux boundary.
    const dataDisposable = terminal.onData((data: string) => {
      void proxy.sendKeys(paneId, data);
    });

    // [LAW:dataflow-not-control-flow] Every resize event sends one setSize.
    // The control connection is the size-driving client; tmux propagates
    // the size to its pane sizing. fitAddon.fit() triggers this via
    // terminal.resize() which fires onResize.
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void proxy.setSize(cols, rows);
    });

    // Initial fit + react to container size changes. Defer the first fit
    // by one animation frame: xterm's Viewport subscribes to onResize
    // inside open() and dereferences the renderer's `dimensions` on the
    // first sync resize, which is undefined until the first paint. Same
    // workaround the reference demo uses.
    let resizeObserver: ResizeObserver | null = null;
    const initialFit = requestAnimationFrame(() => {
      fit.fit();
      resizeObserver = new ResizeObserver(() => {
        fit.fit();
      });
      resizeObserver.observe(container);
    });

    // Subscribe to live byte stream for this pane. Chunks for other panes
    // are filtered out by value; the write call itself is unconditional
    // for the matching pane.
    const offChunk = window.electronAPI.on(
      "tmux:output:chunk",
      (chunk: TmuxOutputChunk) => {
        if (chunk.paneId !== paneId) return;
        terminal.write(chunk.data);
      },
    );

    void window.electronAPI.invoke("tmux:output:subscribe", paneId);

    return () => {
      cancelAnimationFrame(initialFit);
      resizeObserver?.disconnect();
      offChunk();
      void window.electronAPI.invoke("tmux:output:unsubscribe", paneId);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      if (window.__paneTerminal?.terminal === terminal) {
        delete window.__paneTerminal;
      }
    };
  }, [paneId]);

  return (
    <div
      ref={containerRef}
      data-testid="pane-terminal"
      data-pane-id={paneId}
      className="h-96 w-full rounded bg-neutral-950"
    />
  );
}
