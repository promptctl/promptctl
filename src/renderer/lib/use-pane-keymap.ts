// [LAW:single-enforcer] One document-level capture-phase listener per
// renderer. App.tsx mounts the hook once; PaneViewer and the debug route
// reuse the singleton binding for state-change subscriptions. The listener
// runs in the capture phase because xterm's own helper-textarea handler
// would otherwise translate `C-b` into a byte on the wire before the
// keymap gets a chance to intercept it.

import { useEffect, useSyncExternalStore } from "react";
import {
  focusIsXtermPane,
  getPaneKeymap,
  keyEventFromDom,
} from "./pane-keymap";

export function usePaneKeymapListener(): void {
  useEffect(() => {
    const binding = getPaneKeymap();
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!focusIsXtermPane(document.activeElement)) return;
      const consumed = binding.handleKey(keyEventFromDom(ev));
      if (consumed) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}

export function usePaneKeymapMode(): "root" | "prefix" {
  const binding = getPaneKeymap();
  return useSyncExternalStore(
    (onChange) => binding.onStateChange(() => onChange()),
    () => binding.state.mode,
  );
}
