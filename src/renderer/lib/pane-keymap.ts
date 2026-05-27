// [LAW:one-source-of-truth] One KeymapBinding per renderer. The engine's
// "did the user just press the prefix" state belongs to the user's
// keyboard, not to any particular pane — sharing the binding across panes
// is what makes `C-b o` work after focus moves between xterm instances.
//
// [LAW:one-source-of-truth] Tmux's per-client "current pane" cursor and
// the UI's selected pane were two representations of the same fact; the
// commander shim collapses them by prefixing every dispatched command
// with `select-pane -t %X`. Without this, untargeted library commands
// (split-window, resize-pane -Z, select-window -t :N) act on whichever
// pane tmux last touched — not necessarily the pane the user picked in
// the sidebar.
//
// [LAW:single-enforcer] The TmuxCommander shim is the only path from a
// chord to a tmux command. Adding or removing a binding is a one-line
// edit to `defaultTmuxKeymap()`'s data, never a new branch.

import {
  bindKeymap,
  defaultTmuxKeymap,
  type KeyEvent,
  type KeymapBinding,
  type TmuxCommander,
} from "tmux-control-mode-js/keymap";
import { getTmuxProxy } from "../tmux/proxy";
import { usePaneSelectionStore } from "../store/pane-selection";

export interface ProxyExecutor {
  execute(command: string): unknown;
}

// The renderer-side TmuxClientProxy intentionally hides `detach()` — the
// main process owns that lifecycle (closing a renderer must not tear down
// tmux for other windows). The default keymap binds `C-b d` to detach; in
// promptctl the safe behavior is a no-op. The action is not part of the
// ticket's "Done when" set.
export function createPaneCommander(
  proxy: ProxyExecutor,
  getSelectedPaneId: () => string | null,
): TmuxCommander {
  return {
    execute(command: string) {
      // [LAW:dataflow-not-control-flow] The ordering invariant —
      // "select-pane runs before the binding command" — lives in the
      // value (one compound command-line tmux parses sequentially),
      // not in a sequence of execute() calls. One transport write, one
      // FIFO entry; interleaving is structurally impossible because
      // there is nothing to interleave. Per tmux(1) COMMAND PARSING:
      // "if a command in the sequence encounters an error, no
      // subsequent commands are executed" — so if select-pane fails
      // (pane vanished mid-chord) the binding command does not run
      // against a stale target. We are sending the command directly to
      // tmux via control mode (no shell), so plain `;` is the
      // separator; `\;` would be a literal semicolon in an argument.
      const paneId = getSelectedPaneId();
      const composed =
        paneId === null ? command : `select-pane -t ${paneId} ; ${command}`;
      return proxy.execute(composed);
    },
    detach() {
      // intentionally a no-op — see file header
    },
  };
}

let bindingInstance: KeymapBinding | null = null;

export function getPaneKeymap(): KeymapBinding {
  if (bindingInstance === null) {
    bindingInstance = bindKeymap(
      createPaneCommander(
        getTmuxProxy(),
        () => usePaneSelectionStore.getState().selectedPaneId,
      ),
      defaultTmuxKeymap(),
    );
  }
  return bindingInstance;
}

// Reset the engine to root by feeding it an unbound key while in prefix
// mode — per the library's HandleResult contract, "prefix + unbound chord"
// transitions to root with no actions emitted. Escape is unbound in
// `defaultTmuxKeymap`, so this is a no-side-effect cancel. Called by the
// focusout listener so the prefix state doesn't survive the user
// clicking off the pane.
export function resetPrefix(): void {
  getPaneKeymap().handleKey({
    key: "Escape",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
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

// [LAW:dataflow-not-control-flow] The keydown listener runs on every key;
// this predicate decides whether the keymap *sees* the event. Positive
// check against the xterm helper textarea means stray C-b on Live /
// Settings / the sidebar does nothing — the keymap fires only when the
// user is actually typing into a pane.
export function focusIsXtermPane(active: Element | null): boolean {
  return active?.classList.contains("xterm-helper-textarea") ?? false;
}
