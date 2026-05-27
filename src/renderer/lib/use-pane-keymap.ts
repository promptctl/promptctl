// [LAW:single-enforcer] One document-level capture-phase keydown listener
// per renderer, mounted once in App.tsx. The listener runs in the capture
// phase because xterm's own helper-textarea handler would otherwise
// translate `C-b` into a byte on the wire before the keymap gets a
// chance to intercept it.
//
// [LAW:dataflow-not-control-flow] Two event streams feed the engine:
// keydown (chord input) and focusout (cancellation). The engine itself
// doesn't know about focus — the listener layer translates focus events
// into the engine's "feed an unbound key while in prefix → reset to
// root" semantic via `resetPrefix()`. The keymap state can't go stale
// while the user clicks around, and the ⌃B indicator hides
// instantaneously when focus leaves a pane.

import { useEffect, useSyncExternalStore } from "react";
import {
  focusIsXtermPane,
  getPaneKeymap,
  keyEventFromDom,
  resetPrefix,
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

    const onFocusOut = (ev: FocusEvent) => {
      // relatedTarget is the element receiving focus (or null if focus
      // leaves the page). If the next focused element is another xterm
      // pane, preserve the prefix — the user is mid-chord and just
      // switched panes. Otherwise the chord is abandoned.
      const incoming = ev.relatedTarget as Element | null;
      if (focusIsXtermPane(incoming)) return;
      resetPrefix();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focusout", onFocusOut, true);
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
