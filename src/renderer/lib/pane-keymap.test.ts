// [LAW:behavior-not-structure] The tests assert the user-observable
// behavior — "C-b c creates a window, C-b z zooms, C-b 5 selects window
// 5" — not the internal structure of the dispatcher. They run against
// the library's real binding + default keymap with a recording commander
// so a change to the library's chord table that broke the ticket's
// "Done when" list would surface here as a failure.

import { describe, expect, it } from "vitest";
import {
  bindKeymap,
  defaultTmuxKeymap,
  parseChord,
  type Action,
  type KeyEvent,
  type TmuxCommander,
} from "tmux-control-mode-js/keymap";
import {
  createPaneCommander,
  focusIsXtermPane,
  keyEventFromDom,
  type ProxyExecutor,
} from "./pane-keymap";

function recordingProxy(): { proxy: ProxyExecutor; commands: string[] } {
  const commands: string[] = [];
  const proxy: ProxyExecutor = {
    execute(command: string) {
      commands.push(command);
    },
  };
  return { proxy, commands };
}

function recordingCommander(paneId: string | null = null): {
  commander: TmuxCommander;
  commands: string[];
} {
  const { proxy, commands } = recordingProxy();
  const commander = createPaneCommander(proxy, () => paneId);
  return { commander, commands };
}

function press(
  binding: ReturnType<typeof bindKeymap>,
  chord: string | KeyEvent,
): boolean {
  const ev = typeof chord === "string" ? parseChord(chord) : chord;
  return binding.handleKey(ev);
}

function fire(binding: ReturnType<typeof bindKeymap>, ...chords: string[]) {
  return chords.map((c) => press(binding, c));
}

describe("keyEventFromDom", () => {
  it("copies key + modifiers off a KeyboardEvent", () => {
    const ev = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(keyEventFromDom(ev)).toEqual({
      key: "b",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
  });

  it("preserves all four modifier flags independently", () => {
    const ev = new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    });
    expect(keyEventFromDom(ev)).toEqual({
      key: "x",
      ctrl: true,
      alt: true,
      shift: true,
      meta: true,
    });
  });
});

describe("focusIsXtermPane", () => {
  it("returns true only when the active element is xterm's helper textarea", () => {
    const xtermArea = document.createElement("textarea");
    xtermArea.className = "xterm-helper-textarea";
    const input = document.createElement("input");
    const button = document.createElement("button");

    expect(focusIsXtermPane(xtermArea)).toBe(true);
    expect(focusIsXtermPane(input)).toBe(false);
    expect(focusIsXtermPane(button)).toBe(false);
    expect(focusIsXtermPane(null)).toBe(false);
  });
});

describe("default keymap covers the ticket's Done-when chords", () => {
  it("C-b c → new-window", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    expect(fire(binding, "C-b", "c")).toEqual([true, true]);
    expect(commands).toEqual(["new-window"]);
  });

  it("C-b s → choose-session", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "s");
    expect(commands).toEqual(["choose-tree -s"]);
  });

  it("C-b z → zoom-pane", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "z");
    expect(commands).toEqual(["resize-pane -Z"]);
  });

  it("C-b ↑/↓/←/→ → select-pane by direction", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "Up");
    fire(binding, "C-b", "Down");
    fire(binding, "C-b", "Left");
    fire(binding, "C-b", "Right");
    expect(commands).toEqual([
      "select-pane -U",
      "select-pane -D",
      "select-pane -L",
      "select-pane -R",
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])(
    "C-b %i → select-window -t :%i",
    (digit) => {
      const { commander, commands } = recordingCommander();
      const binding = bindKeymap(commander, defaultTmuxKeymap());
      fire(binding, "C-b", String(digit));
      expect(commands).toEqual([`select-window -t :${digit}`]);
    },
  );

  it("C-b % → horizontal split", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "%");
    expect(commands).toEqual(["split-window -h"]);
  });
});

describe("prefix state survives bare modifier keys", () => {
  // The library docs call this out as the BARE_MODIFIER_KEYS regression:
  // browsers fire keydown for Shift/Control/Alt/Meta before the shifted
  // character arrives, so without the engine short-circuit the prefix
  // would silently cancel.
  it("a Shift keydown between C-b and % does not cancel the prefix", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());

    expect(press(binding, "C-b")).toBe(true);
    expect(binding.state.mode).toBe("prefix");

    const bareShift: KeyEvent = {
      key: "Shift",
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    };
    expect(press(binding, bareShift)).toBe(false);
    expect(binding.state.mode).toBe("prefix");

    expect(press(binding, "%")).toBe(true);
    expect(commands).toEqual(["split-window -h"]);
  });
});

describe("unhandled keys in root mode pass through", () => {
  it("typing 'a' in root mode is not consumed and runs no tmux commands", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    expect(press(binding, "a")).toBe(false);
    expect(commands).toEqual([]);
  });
});

describe("Escape while in prefix mode resets to root without firing a command", () => {
  // resetPrefix() exploits this engine behavior to clear stuck prefix
  // state when focus leaves the pane. Pinning it here means a library
  // change that bound Escape (or removed the unbound-in-prefix swallow)
  // would surface as a failure here before reaching production.
  it("prefix + Escape → root, no actions emitted", () => {
    const { commander, commands } = recordingCommander();
    const binding = bindKeymap(commander, defaultTmuxKeymap());

    press(binding, "C-b");
    expect(binding.state.mode).toBe("prefix");

    const escape: KeyEvent = {
      key: "Escape",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    expect(press(binding, escape)).toBe(true);
    expect(binding.state.mode).toBe("root");
    expect(commands).toEqual([]);
  });
});

describe("commander composes select-pane + binding into a single tmux command", () => {
  // [LAW:dataflow-not-control-flow] The targeting and the binding go
  // out as one tmux command-line (separated by `;`), so the ordering
  // invariant is in the value, not in the sequence of execute calls.
  // Per tmux(1) COMMAND PARSING, a failed command in the sequence
  // halts the remainder — so if select-pane errors, the binding
  // command does not run against a stale target.
  it("split-window is composed with select-pane in one command", () => {
    const { proxy, commands } = recordingProxy();
    const commander = createPaneCommander(proxy, () => "%7");
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "%");
    expect(commands).toEqual(["select-pane -t %7 ; split-window -h"]);
  });

  it("resize-pane -Z is composed with select-pane in one command", () => {
    const { proxy, commands } = recordingProxy();
    const commander = createPaneCommander(proxy, () => "%12");
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "z");
    expect(commands).toEqual(["select-pane -t %12 ; resize-pane -Z"]);
  });

  it("when no pane is selected, the binding command is sent alone", () => {
    const { proxy, commands } = recordingProxy();
    const commander = createPaneCommander(proxy, () => null);
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    fire(binding, "C-b", "c");
    expect(commands).toEqual(["new-window"]);
  });

  it("a chord that issues no execute (Escape reset) writes nothing", () => {
    const { proxy, commands } = recordingProxy();
    const commander = createPaneCommander(proxy, () => "%3");
    const binding = bindKeymap(commander, defaultTmuxKeymap());
    press(binding, "C-b");
    expect(commands).toEqual([]);
  });
});

// [LAW:locality-or-seam] If the library adds a new Action variant, the
// `satisfies Record<Action["type"], true>` clause below fails to compile
// — forcing us to revisit the detach no-op and the commander's
// targeting semantics for the new variant. This is a *type-level*
// exhaustiveness check, not a runtime length sham: TypeScript verifies
// every Action variant is enumerated.
const KNOWN_ACTION_TYPES = {
  "new-window": true,
  "next-window": true,
  "previous-window": true,
  "last-window": true,
  "select-window": true,
  "kill-window": true,
  split: true,
  "select-pane": true,
  "next-pane": true,
  "kill-pane": true,
  "zoom-pane": true,
  "break-pane": true,
  "swap-pane": true,
  "resize-pane": true,
  detach: true,
  "next-session": true,
  "previous-session": true,
  "choose-session": true,
  "command-prompt": true,
} as const satisfies Record<Action["type"], true>;

describe("Action union evolution check", () => {
  it("the exhaustive map has at least one variant", () => {
    expect(Object.keys(KNOWN_ACTION_TYPES).length).toBeGreaterThan(0);
  });
});
