// [LAW:one-source-of-truth] One KeymapBinding per renderer. The engine's
// "did the user just press the prefix" state belongs to the user's
// keyboard, not to any particular pane — sharing the binding across panes
// is what makes `C-b o` (next-pane) work from anywhere instead of
// resetting the moment focus moves between xterm instances.
//
// [LAW:single-enforcer] The TmuxCommander shim wraps the singleton
// getTmuxProxy() — there is exactly one path from a chord to a tmux
// command. Adding or removing a binding is a one-line edit to
// `defaultTmuxKeymap()`'s data, never a new branch.

import {
  bindKeymap,
  defaultTmuxKeymap,
  type KeyEvent,
  type KeymapBinding,
  type TmuxCommander,
} from "tmux-control-mode-js/keymap";
import { getTmuxProxy } from "../tmux/proxy";

// The renderer-side TmuxClientProxy intentionally hides `detach()` — the
// main process owns that lifecycle (closing a renderer must not tear down
// tmux for other windows). The default keymap binds `C-b d` to detach;
// in promptctl the safe behavior is a no-op. The action is not part of
// the ticket's "Done when" set.
function paneCommander(): TmuxCommander {
  const proxy = getTmuxProxy();
  return {
    execute(command: string) {
      return proxy.execute(command);
    },
    detach() {
      // intentionally a no-op — see file header
    },
  };
}

let bindingInstance: KeymapBinding | null = null;

export function getPaneKeymap(): KeymapBinding {
  if (bindingInstance === null) {
    bindingInstance = bindKeymap(paneCommander(), defaultTmuxKeymap());
  }
  return bindingInstance;
}

export function keyEventFromDom(ev: KeyboardEvent): KeyEvent {
  return {
    key: ev.key,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    shift: ev.shiftKey,
    meta: ev.metaKey,
  };
}

// [LAW:dataflow-not-control-flow] The listener runs on every keydown; this
// predicate decides whether the keymap *sees* the event. Positive check
// against the xterm helper textarea means stray C-b on Live/Settings/the
// sidebar does nothing — the keymap fires only when the user is actually
// typing into a pane.
export function focusIsXtermPane(active: Element | null): boolean {
  return active?.classList.contains("xterm-helper-textarea") ?? false;
}
