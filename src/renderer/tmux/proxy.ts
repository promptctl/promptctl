// [LAW:one-source-of-truth] All renderer-side tmux access flows through the
// singleton TmuxClientProxy returned here. The proxy mirrors the public shape
// of the library's TmuxClient over IPC; nothing else in the renderer should
// hand-roll tmux:invoke calls.
//
// [LAW:single-enforcer] One construction site per renderer. The library bridge
// in main installs `tmux:invoke` once per process — and a renderer that creates
// two TmuxClientProxy instances would double-register `tmux:event` listeners
// on the same ipcRenderer. getTmuxProxy() guards that.

import { useEffect, useState } from "react";
import {
  createRendererBridge,
  type TmuxClientProxy,
} from "tmux-control-mode-js/electron/renderer";
import { PaneStream } from "@promptctl/pane-terminal/stream";
import type { TmuxControlState } from "../env";
import type { PaneId, TmuxPane, TmuxSnapshot } from "../../shared/types";

let proxyInstance: TmuxClientProxy | null = null;

export function getTmuxProxy(): TmuxClientProxy {
  if (proxyInstance === null) {
    proxyInstance = createRendererBridge(window.tmuxIpc);
  }
  return proxyInstance;
}

const INITIAL_CONTROL_STATE: TmuxControlState = {
  status: "connecting",
  reconnectAttempts: 0,
  observedSessions: 0,
};

// [LAW:dataflow-not-control-flow] Hook returns a single state value seeded by
// `tmux:control-state:get` and updated by `tmux:control-state` broadcasts.
// Components render the same way for connecting/ready/closed — only the data
// varies.
export function useControlState(): TmuxControlState {
  const [state, setState] = useState<TmuxControlState>(INITIAL_CONTROL_STATE);

  useEffect(() => {
    let alive = true;
    const off = window.electronAPI.on("tmux:control-state", (event) => {
      if (alive) setState(event);
    });
    void window.electronAPI.invoke("tmux:control-state:get").then((current) => {
      if (alive) setState(current);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return state;
}

const INITIAL_TOPOLOGY: TmuxSnapshot = { timestamp: 0, panes: [] };

// [LAW:dataflow-not-control-flow] Same shape as useControlState — seed via
// the get-channel, update via broadcasts. The render path doesn't branch on
// "is the topology populated"; an empty panes array renders an empty list.
export function useTopology(): TmuxSnapshot {
  const [snapshot, setSnapshot] = useState<TmuxSnapshot>(INITIAL_TOPOLOGY);

  useEffect(() => {
    let alive = true;
    const off = window.electronAPI.on("tmux:topology", (next) => {
      if (alive) setSnapshot(next);
    });
    void window.electronAPI.invoke("tmux:topology:get").then((current) => {
      if (alive) setSnapshot(current);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return snapshot;
}

// [LAW:locality-or-seam] The renderer's only path from a topology pane to a
// library PaneStream lives here. Components pass the selected `TmuxPane` (or
// `null`) and hand the result to `<PaneTerminal stream={}>`; nothing else
// strips the `%` prefix or constructs PaneStream by hand. Taking the whole pane
// rather than a (paneId, sessionId) pair makes the "id without its session"
// state unrepresentable at the call boundary.
//
// [LAW:single-enforcer] One stream per (pane, mount); the prior stream is
// disposed before a fresh one is constructed. Output for every session flows
// through the mesh in main (one control client per observed session), so the
// renderer never has to drive attached-session selection — every pane's
// %output reaches the bridge regardless of which one is focused.
//
// [LAW:types-are-the-program] The stream is created in an effect, so the `stream`
// state lags the render that changed `paneId` by one tick. Pairing the stream
// with the paneId it was built for lets the return reject a stream that belongs
// to a stale selection: <PaneTerminal> is never handed a stream for a different
// pane than the current one, so keystrokes can't be routed to the previous pane
// during a fast switch. The matched-pane gate makes that mismatch unrepresentable.
export function usePaneStream(pane: TmuxPane | null): PaneStream | null {
  const paneId = pane?.id ?? null;
  const [active, setActive] = useState<{
    paneId: PaneId;
    stream: PaneStream;
  } | null>(null);

  useEffect(() => {
    if (paneId === null) {
      setActive(null);
      return undefined;
    }
    const numericPaneId = Number.parseInt(paneId.replace(/^%/, ""), 10);
    const next = new PaneStream({
      client: getTmuxProxy(),
      paneId: numericPaneId,
    });
    setActive({ paneId, stream: next });
    return () => {
      next.dispose();
      setActive(null);
    };
  }, [paneId]);

  return active?.paneId === paneId ? active.stream : null;
}
