// [LAW:dataflow-not-control-flow] The list is a pure projection of
// useLaunchStore. These tests drive the store and observe the rendered
// rows. The component does not branch on launch identity or "is this
// the main one"; the assertions reflect that.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaunchExited,
  LaunchId,
  LaunchPending,
  LaunchRunning,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";
import { useLaunchStore } from "../store/launches";
import { setupUser } from "../../test/user-event";
import {
  WorkshopLaunchList,
  launchDetailRoute,
} from "./WorkshopLaunchList";

function runningClaude(over: Partial<LaunchRunning> = {}): LaunchRunning {
  return {
    launchId: "L-run" as LaunchId,
    toolKind: "claude",
    paneId: "%1" as PaneId,
    sessionId: "$1" as SessionId,
    windowId: "@1" as WindowId,
    cwd: "/repo/run",
    startedAt: 3,
    env: {},
    status: "running",
    pid: 1234,
    proxyClientId: null,
    sessionFilePath: null,
    ...over,
  };
}

function pendingCodex(over: Partial<LaunchPending> = {}): LaunchPending {
  return {
    launchId: "L-pend" as LaunchId,
    toolKind: "codex",
    paneId: "%2" as PaneId,
    sessionId: "$2" as SessionId,
    windowId: "@2" as WindowId,
    cwd: "/repo/pend",
    startedAt: 2,
    env: {},
    status: "pending",
    ...over,
  };
}

function exitedGemini(over: Partial<LaunchExited> = {}): LaunchExited {
  return {
    launchId: "L-exit" as LaunchId,
    toolKind: "gemini",
    paneId: "%3" as PaneId,
    sessionId: "$3" as SessionId,
    windowId: "@3" as WindowId,
    cwd: "/repo/exit",
    startedAt: 1,
    env: {},
    status: "exited",
    pid: null,
    proxyClientId: null,
    sessionFilePath: null,
    exitedAt: 99,
    exitReason: "done",
    ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="location">
      <span data-testid="location-pathname">{loc.pathname}</span>
      <span data-testid="location-search">{loc.search}</span>
    </div>
  );
}

function renderList(onNewLaunch = () => undefined) {
  return render(
    <MemoryRouter initialEntries={["/workshop"]}>
      {/* LocationProbe lives outside Routes so it observes navigations
          that change only the search string (same path, new ?launchId). */}
      <LocationProbe />
      <Routes>
        <Route
          path="/workshop"
          element={<WorkshopLaunchList onNewLaunch={onNewLaunch} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  useLaunchStore.setState({ launches: [] });
});

afterEach(() => {
  useLaunchStore.setState({ launches: [] });
});

describe("WorkshopLaunchList", () => {
  it("renders an empty hint when there are no launches", () => {
    renderList();
    expect(screen.queryAllByTestId("workshop-launch-row")).toHaveLength(0);
    expect(screen.getByText(/No launches yet/i)).toBeInTheDocument();
  });

  it("renders one row per launch, regardless of status or tool kind", () => {
    // [LAW:one-type-per-behavior] Every launch is a launch — no row
    // type per tool kind, no row type per status.
    useLaunchStore.setState({
      launches: [runningClaude(), pendingCodex(), exitedGemini()],
    });
    renderList();
    const rows = screen.getAllByTestId("workshop-launch-row");
    expect(rows).toHaveLength(3);
    // Each row carries its data on the DOM so the rest of the UI
    // (selectors, tests, future cross-references) can find it without
    // text-matching.
    const statuses = rows.map((r) => r.getAttribute("data-launch-status"));
    expect(new Set(statuses)).toEqual(
      new Set(["running", "pending", "exited"]),
    );
    const tools = rows.map((r) => r.getAttribute("data-launch-tool"));
    expect(new Set(tools)).toEqual(new Set(["claude", "codex", "gemini"]));
  });

  it("sorts running first, then pending, then exited", () => {
    useLaunchStore.setState({
      launches: [exitedGemini(), pendingCodex(), runningClaude()],
    });
    renderList();
    const order = screen
      .getAllByTestId("workshop-launch-row")
      .map((r) => r.getAttribute("data-launch-status"));
    expect(order).toEqual(["running", "pending", "exited"]);
  });

  it("invokes onNewLaunch when the New launch button is clicked", async () => {
    const user = setupUser();
    const onNewLaunch = vi.fn();
    renderList(onNewLaunch);
    await user.click(screen.getByTestId("workshop-new-launch"));
    expect(onNewLaunch).toHaveBeenCalledTimes(1);
  });

  it("navigates to /workshop?launchId=... when a row is clicked", async () => {
    const user = setupUser();
    useLaunchStore.setState({
      launches: [runningClaude({ launchId: "L-row-click" as LaunchId })],
    });
    renderList();
    const row = screen.getByTestId("workshop-launch-row");
    expect(row.getAttribute("data-launch-id")).toBe("L-row-click");
    await user.click(row);
    expect(screen.getByTestId("location-pathname").textContent).toBe(
      "/workshop",
    );
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?launchId=L-row-click",
    );
  });

  it("activates a row via keyboard (Enter) — the row is a real button, not a div", async () => {
    // The row uses a native <button> so keyboard focus + Enter/Space
    // activation come for free. This test pins that behavior so a
    // future refactor that drops the button (e.g. back to a div with
    // onClick) immediately surfaces in CI as a keyboard-nav regression.
    const user = setupUser();
    useLaunchStore.setState({
      launches: [runningClaude({ launchId: "L-kbd" as LaunchId })],
    });
    renderList();
    const row = screen.getByTestId("workshop-launch-row");
    expect(row.tagName).toBe("BUTTON");
    row.focus();
    expect(document.activeElement).toBe(row);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?launchId=L-kbd",
    );
  });

  it("encodes special characters in launchIds — defense at the URL boundary", () => {
    // The brand on LaunchId admits arbitrary strings (synthetic ids
    // from HAR replays are derived from filename basenames, and can
    // carry `&`, spaces, etc.). launchDetailRoute is the single URL-
    // shape site, so the encoding lives there once and every callsite
    // gets safe routes for free.
    const id = "replay-foo & bar baz" as LaunchId;
    const route = launchDetailRoute(id);
    expect(route).toBe("/workshop?launchId=replay-foo+%26+bar+baz");
    // Round-trip: URLSearchParams.get decodes it back to the original.
    const recovered = new URLSearchParams(route.split("?")[1]).get(
      "launchId",
    );
    expect(recovered).toBe(id);
  });

  it("surfaces sessionFilePath when present on a running/exited row", () => {
    useLaunchStore.setState({
      launches: [
        runningClaude({
          launchId: "L-with-path" as LaunchId,
          sessionFilePath: "/tmp/live.jsonl",
        }),
        runningClaude({
          launchId: "L-no-path" as LaunchId,
          sessionFilePath: null,
        }),
      ],
    });
    renderList();
    const paths = screen.getAllByTestId("workshop-launch-row-session-path");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveTextContent("/tmp/live.jsonl");
  });
});
