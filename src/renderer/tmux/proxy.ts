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
import type { TmuxPane, TmuxSnapshot } from "../../shared/types";

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
    void window.electronAPI
      .invoke("tmux:control-state:get")
      .then((current) => {
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
// disposed before a fresh one is constructed. The attached session is NOT this
// hook's to drive — tmux delivers %output only for the attached session, so the
// renderer sends that intent to main (the lone owner across reconnects) and
// constructs the stream; it never issues switch-client itself.
export function usePaneStream(pane: TmuxPane | null): PaneStream | null {
  const paneId = pane?.id ?? null;
  const sessionId = pane?.sessionId ?? null;
  const [stream, setStream] = useState<PaneStream | null>(null);

  useEffect(() => {
    void window.electronAPI.invoke("tmux:watch-session", sessionId);
    if (paneId === null) {
      setStream(null);
      return undefined;
    }
    const numericPaneId = Number.parseInt(paneId.replace(/^%/, ""), 10);
    const next = new PaneStream({
      client: getTmuxProxy(),
      paneId: numericPaneId,
    });
    setStream(next);
    return () => {
      next.dispose();
      setStream(null);
    };
  }, [paneId, sessionId]);

  return stream;
}
