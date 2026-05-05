import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installElectronMock, setInvokeHandlers } from "../../test/electron-mock";
import type { PaneId, TmuxOutputChunk } from "../../shared/types";
import { useOutputStream } from "./proxy";

const PANE_A = "%1" as PaneId;
const PANE_B = "%2" as PaneId;

function chunk(paneId: PaneId, data: string): TmuxOutputChunk {
  return { paneId, data };
}

beforeEach(() => {
  const api = installElectronMock();
  setInvokeHandlers(api, {
    "tmux:output:subscribe": () => undefined,
    "tmux:output:unsubscribe": () => undefined,
  });
});

afterEach(() => {
  // installElectronMock overwrites; nothing to tear down.
});

describe("useOutputStream", () => {
  it("appends chunks addressed to the subscribed pane", () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:output:subscribe": () => undefined,
      "tmux:output:unsubscribe": () => undefined,
    });

    const { result } = renderHook(() => useOutputStream(PANE_A));

    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_A, "hello"));
    });

    expect(result.current.text).toBe("hello");
  });

  it("ignores chunks addressed to a different pane", () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:output:subscribe": () => undefined,
      "tmux:output:unsubscribe": () => undefined,
    });

    const { result } = renderHook(() => useOutputStream(PANE_A));

    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_B, "leaked"));
    });

    expect(result.current.text).toBe("");
  });

  it("after switching panes, drops in-flight chunks for the previous pane", () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:output:subscribe": () => undefined,
      "tmux:output:unsubscribe": () => undefined,
    });

    const { result, rerender } = renderHook(
      ({ paneId }: { paneId: PaneId | null }) => useOutputStream(paneId),
      { initialProps: { paneId: PANE_A as PaneId | null } },
    );

    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_A, "for-A"));
    });
    expect(result.current.text).toBe("for-A");

    rerender({ paneId: PANE_B });

    // In-flight chunk for old pane lands after the switch — must be ignored.
    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_A, "stale"));
    });
    expect(result.current.text).toBe("");

    act(() => {
      api.emit("tmux:output:chunk", chunk(PANE_B, "for-B"));
    });
    expect(result.current.text).toBe("for-B");
  });
});
