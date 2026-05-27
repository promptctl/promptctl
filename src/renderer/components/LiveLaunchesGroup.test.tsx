import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LiveLaunchesGroup } from "./LiveLaunchesGroup";
import { useLaunchStore } from "../store/launches";
import type {
  Launch,
  LaunchId,
  LaunchPending,
  LaunchRunning,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";

function runningClaude(over: Partial<LaunchRunning> = {}): LaunchRunning {
  return {
    launchId: "lc-1" as LaunchId,
    toolKind: "claude",
    paneId: "%1" as PaneId,
    sessionId: "$1" as SessionId,
    windowId: "@1" as WindowId,
    cwd: "/repo/foo",
    startedAt: 1_700_000_000_000,
    env: {},
    status: "running",
    pid: 1,
    proxyClientId: null,
    sessionFilePath: null,
    ...over,
  };
}

function seed(launches: Launch[]): void {
  useLaunchStore.getState().setLaunches(launches);
}

describe("LiveLaunchesGroup", () => {
  beforeEach(() => {
    seed([]);
  });

  it("renders nothing when there are no running Claude launches", () => {
    const { container } = render(
      <LiveLaunchesGroup activeFilePath={null} onAdopt={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a row per running Claude launch with sessionFilePath → Adopt button", () => {
    seed([
      runningClaude({
        launchId: "lc-a" as LaunchId,
        cwd: "/repo/a",
        sessionFilePath: "/path/to/a.jsonl",
      }),
      runningClaude({
        launchId: "lc-b" as LaunchId,
        cwd: "/repo/b",
        sessionFilePath: "/path/to/b.jsonl",
      }),
    ]);

    render(
      <LiveLaunchesGroup activeFilePath={null} onAdopt={() => undefined} />,
    );

    const rows = screen.getAllByTestId("live-launch-row");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Adopt" })).toHaveLength(2);
  });

  it("shows 'waiting…' instead of Adopt when sessionFilePath is null", () => {
    seed([
      runningClaude({
        launchId: "lc-pending" as LaunchId,
        sessionFilePath: null,
      }),
    ]);
    render(
      <LiveLaunchesGroup activeFilePath={null} onAdopt={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "Adopt" })).toBeNull();
    expect(screen.getByText("waiting…")).toBeInTheDocument();
  });

  it("marks the row as Adopted when the launch's sessionFilePath matches activeFilePath", () => {
    seed([
      runningClaude({ sessionFilePath: "/path/to/live.jsonl" }),
    ]);
    render(
      <LiveLaunchesGroup
        activeFilePath="/path/to/live.jsonl"
        onAdopt={() => undefined}
      />,
    );
    expect(screen.getByText("Adopted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).toBeNull();
  });

  it("invokes onAdopt with the launch and its sessionFilePath when Adopt is clicked", () => {
    const launch = runningClaude({
      launchId: "lc-adopt" as LaunchId,
      sessionFilePath: "/path/to/live.jsonl",
    });
    seed([launch]);
    const onAdopt = vi.fn();
    render(
      <LiveLaunchesGroup activeFilePath={null} onAdopt={onAdopt} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));

    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledWith(launch, "/path/to/live.jsonl");
  });

  it("excludes non-Claude launches and exited launches", () => {
    const codex: LaunchRunning = runningClaude({
      launchId: "lc-codex" as LaunchId,
      toolKind: "codex",
      sessionFilePath: "/x.jsonl",
    });
    const pending: LaunchPending = {
      launchId: "lc-pending" as LaunchId,
      toolKind: "claude",
      paneId: "%2" as PaneId,
      sessionId: "$2" as SessionId,
      windowId: "@2" as WindowId,
      cwd: "/repo/p",
      startedAt: 1,
      env: {},
      status: "pending",
    };
    const exited: Launch = {
      launchId: "lc-exited" as LaunchId,
      toolKind: "claude",
      paneId: "%3" as PaneId,
      sessionId: "$3" as SessionId,
      windowId: "@3" as WindowId,
      cwd: "/repo/e",
      startedAt: 1,
      env: {},
      status: "exited",
      pid: null,
      proxyClientId: null,
      sessionFilePath: "/x.jsonl",
      exitedAt: 2,
      exitReason: "done",
    };

    seed([codex, pending, exited]);
    const { container } = render(
      <LiveLaunchesGroup activeFilePath={null} onAdopt={() => undefined} />,
    );
    // All three filtered out → nothing to render → null first child.
    expect(container.firstChild).toBeNull();
  });
});
