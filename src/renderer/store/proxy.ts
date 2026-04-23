// [LAW:one-source-of-truth] Derived projection of main-process proxy state.
// Events arrive via IPC, status changes arrive via IPC, both flow into here.
import { create } from "zustand";
import type { ProxyEvent, ProxyStatus } from "../../shared/proxy-events";

// In-memory cap. The Live tab is an event log; we keep a bounded buffer so
// long-running sessions don't grow renderer memory unbounded. The HAR file
// is the persistent source of truth — losing the head of the in-memory log
// doesn't lose data.
const MAX_EVENTS = 5000;

interface ProxyStore {
  status: ProxyStatus;
  events: ProxyEvent[];
  setStatus: (status: ProxyStatus) => void;
  appendEvent: (event: ProxyEvent) => void;
  clearEvents: () => void;
  // Replace the entire event buffer (used after loadHar replays).
  resetEvents: () => void;
}

const INITIAL_STATUS: ProxyStatus = {
  running: false,
  port: 0,
  upstreamTarget: "",
  recordingPath: null,
  entryCount: 0,
};

export const useProxyStore = create<ProxyStore>((set) => ({
  status: INITIAL_STATUS,
  events: [],
  setStatus: (status) => set({ status }),
  appendEvent: (event) =>
    set((state) => {
      const next = state.events.length >= MAX_EVENTS
        ? [...state.events.slice(state.events.length - MAX_EVENTS + 1), event]
        : [...state.events, event];
      return { events: next };
    }),
  clearEvents: () => set({ events: [] }),
  resetEvents: () => set({ events: [] }),
}));

export function initProxySubscription(): () => void {
  const unsubEvent = window.electronAPI.on("proxy:event", (event) => {
    useProxyStore.getState().appendEvent(event as ProxyEvent);
  });
  const unsubStatus = window.electronAPI.on("proxy:status", (status) => {
    useProxyStore.getState().setStatus(status as ProxyStatus);
  });
  window.electronAPI.send("proxy:subscribe");
  return () => {
    unsubEvent();
    unsubStatus();
    window.electronAPI.send("proxy:unsubscribe");
  };
}
