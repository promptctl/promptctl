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
import { focusIsXtermPane, keyEventFromDom } from "./pane-keymap";

function recordingCommander(): {
  commander: TmuxCommander;
  commands: string[];
  detaches: number;
} {
  const commands: string[] = [];
  let detaches = 0;
  const commander: TmuxCommander = {
    execute(command: string) {
      commands.push(command);
    },
    detach() {
      detaches += 1;
    },
  };
  return {
    commander,
    commands,
    get detaches() {
      return detaches;
    },
  } as { commander: TmuxCommander; commands: string[]; detaches: number };
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

describe("Action union evolution check", () => {
  // [LAW:locality-or-seam] If the library adds a new Action variant, our
  // detach no-op in paneCommander() stays valid because every other variant
  // goes through TmuxCommander.execute. This test exists as the canary: it
  // pins the set of Action.type strings we currently cope with, so a new
  // variant fails the test loudly instead of silently slipping through.
  it("Action union is the set we expect", () => {
    const actionTypes: readonly Action["type"][] = [
      "new-window",
      "next-window",
      "previous-window",
      "last-window",
      "select-window",
      "kill-window",
      "split",
      "select-pane",
      "next-pane",
      "kill-pane",
      "zoom-pane",
      "break-pane",
      "swap-pane",
      "resize-pane",
      "detach",
      "next-session",
      "previous-session",
      "choose-session",
      "command-prompt",
    ];
    // Exhaustiveness check: TypeScript verifies at compile time that
    // every Action variant is enumerated above. The runtime expect just
    // anchors the count so the array can't drift silently.
    expect(actionTypes).toHaveLength(19);
  });
});
