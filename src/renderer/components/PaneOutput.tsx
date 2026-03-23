import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { PaneId } from "../../shared/types";
import { usePaneOutputStore } from "../store/pane-output";

export function PaneOutput({ paneId }: { paneId: PaneId }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastWrittenLength = useRef(0);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#171717",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#404040",
      },
      convertEol: true,
      scrollback: 10000,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    lastWrittenLength.current = 0;

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [paneId]);

  // Subscribe to output and write to terminal
  useEffect(() => {
    const unsubscribe = usePaneOutputStore.subscribe((state) => {
      const buffer = state.buffers[paneId] ?? "";
      const term = termRef.current;
      if (!term || buffer.length <= lastWrittenLength.current) return;

      const newData = buffer.slice(lastWrittenLength.current);
      lastWrittenLength.current = buffer.length;
      term.write(newData);
    });

    // Write any existing buffer content
    const existing = usePaneOutputStore.getState().buffers[paneId] ?? "";
    if (existing.length > 0 && termRef.current) {
      termRef.current.write(existing);
      lastWrittenLength.current = existing.length;
    }

    return unsubscribe;
  }, [paneId]);

  // Watch/unwatch pane output in main process
  useEffect(() => {
    window.electronAPI.send("tmux:watch-pane", paneId);
    return () => {
      window.electronAPI.send("tmux:unwatch-pane", paneId);
    };
  }, [paneId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-lg bg-neutral-900"
    />
  );
}
