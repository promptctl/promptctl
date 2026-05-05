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
import type { TmuxControlState } from "../env";
import type {
  TmuxOutputState,
  TmuxOutputChunk,
  TmuxOutputStateEvent,
  TmuxSnapshot,
  PaneId,
} from "../../shared/types";

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

const MAX_OUTPUT_BUFFER = 100_000;

export interface OutputStreamState {
  text: string;
  state: TmuxOutputState;
}

const IDLE_OUTPUT: OutputStreamState = { text: "", state: "disconnected" };

// [LAW:dataflow-not-control-flow] The hook runs the same sequence regardless
// of state: subscribe → accumulate chunks → unsubscribe. The state marker
// (streaming/paused/disconnected) is data the component renders, not a branch
// that gates work. An unselected pane (null) returns the idle constant.
export function useOutputStream(paneId: PaneId | null): OutputStreamState {
  const [output, setOutput] = useState<OutputStreamState>(IDLE_OUTPUT);

  useEffect(() => {
    if (paneId === null) {
      setOutput(IDLE_OUTPUT);
      return;
    }

    let alive = true;
    // Seed with fresh state on each pane change.
    setOutput({ text: "", state: "streaming" });

    const offChunk = window.electronAPI.on(
      "tmux:output:chunk",
      (chunk: TmuxOutputChunk) => {
        if (!alive) return;
        // Mirror the paneId filter on the state listener: on pane switch,
        // in-flight chunks for the previous pane are still on the renderer
        // event queue and must not land in the new pane's buffer.
        if (chunk.paneId !== paneId) return;
        setOutput((prev) => {
          const next = prev.text + chunk.data;
          return {
            text: next.length > MAX_OUTPUT_BUFFER
              ? next.slice(-MAX_OUTPUT_BUFFER)
              : next,
            state: prev.state,
          };
        });
      },
    );

    const offState = window.electronAPI.on(
      "tmux:output:state",
      (event: TmuxOutputStateEvent) => {
        if (!alive) return;
        if (event.paneId !== paneId) return;
        setOutput((prev) => ({ ...prev, state: event.state }));
      },
    );

    void window.electronAPI
      .invoke("tmux:output:subscribe", paneId)
      .then(() => {
        if (!alive) {
          void window.electronAPI.invoke("tmux:output:unsubscribe", paneId);
        }
      });

    return () => {
      alive = false;
      offChunk();
      offState();
      void window.electronAPI.invoke("tmux:output:unsubscribe", paneId);
    };
  }, [paneId]);

  return output;
}
