import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installElectronMock,
  setInvokeHandlers,
  type MockElectronAPI,
} from "../../test/electron-mock";
import type {
  PaneId,
  PaneProcesses,
  SessionId,
  TmuxPane,
  WindowId,
} from "../../shared/types";
import { ProcessInfoPanel } from "./ProcessInfoPanel";

function pane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: "%1" as PaneId,
    sessionName: "s",
    sessionId: "$0" as SessionId,
    windowName: "w",
    windowId: "@0" as WindowId,
    windowIndex: 0,
    paneIndex: 0,
    pid: 1234,
    currentCommand: "zsh",
    currentPath: "/tmp",
    width: 80,
    height: 24,
    active: true,
    toolKind: "unknown",
    ...overrides,
  };
}

function emptyProcesses(p: TmuxPane): PaneProcesses {
  return { paneId: p.id, panePid: p.pid, children: [], timestamp: 0 };
}

let api: MockElectronAPI;
let invokeCount = 0;

beforeEach(() => {
  invokeCount = 0;
  api = installElectronMock();
  setInvokeHandlers(api, {
    "tmux:pane-processes": (paneId: unknown): PaneProcesses => {
      invokeCount++;
      return {
        paneId: paneId as PaneId,
        panePid: 1234,
        children: [],
        timestamp: 0,
      };
    },
  });
});

afterEach(() => cleanup());

describe("ProcessInfoPanel", () => {
  it("fetches once on mount", async () => {
    render(<ProcessInfoPanel pane={pane()} />);
    await waitFor(() => expect(invokeCount).toBe(1));
  });

  it("refetches when pane.currentCommand changes", async () => {
    const { rerender } = render(<ProcessInfoPanel pane={pane()} />);
    await waitFor(() => expect(invokeCount).toBe(1));
    rerender(<ProcessInfoPanel pane={pane({ currentCommand: "claude" })} />);
    await waitFor(() => expect(invokeCount).toBe(2));
  });

  it("refetches when pane.pid changes", async () => {
    const { rerender } = render(<ProcessInfoPanel pane={pane()} />);
    await waitFor(() => expect(invokeCount).toBe(1));
    rerender(<ProcessInfoPanel pane={pane({ pid: 9999 })} />);
    await waitFor(() => expect(invokeCount).toBe(2));
  });

  it("does NOT refetch when an irrelevant prop ticks (size, path, active)", async () => {
    const { rerender } = render(<ProcessInfoPanel pane={pane()} />);
    await waitFor(() => expect(invokeCount).toBe(1));
    rerender(
      <ProcessInfoPanel
        pane={pane({ width: 120, height: 40, currentPath: "/var", active: false })}
      />,
    );
    // Allow any pending microtasks to flush; count must still be 1.
    await Promise.resolve();
    expect(invokeCount).toBe(1);
  });

  it("does not poll on a timer — advancing fake clock past 5s does not refetch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ProcessInfoPanel pane={pane()} />);
      await waitFor(() => expect(invokeCount).toBe(1));
      // The pre-refactor code polled every 5s; advancing >10s would have
      // produced at least 2 extra invokes. After the refactor, refetch is
      // dataflow-driven (pane.id/currentCommand/pid), so the count stays at 1.
      vi.advanceTimersByTime(12_000);
      await Promise.resolve();
      expect(invokeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refresh button triggers a refetch when expanded", async () => {
    const user = userEvent.setup({ delay: null });
    render(<ProcessInfoPanel pane={pane()} />);
    await waitFor(() => expect(invokeCount).toBe(1));
    await user.click(screen.getByTestId("loops-process-info-toggle"));
    const refresh = await screen.findByTestId("loops-process-info-refresh");
    await user.click(refresh);
    await waitFor(() => expect(invokeCount).toBe(2));
  });

  it("logs and recovers when the IPC invoke rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setInvokeHandlers(api, {
      "tmux:pane-processes": () => Promise.reject(new Error("boom")),
    });
    render(<ProcessInfoPanel pane={pane()} />);
    // The rejection is logged (visible in dev console) rather than swallowed,
    // and the panel stays mounted with a stable "0 children" affordance.
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.getByTestId("loops-process-info-toggle")).toHaveTextContent(
      "0 child processes",
    );
    spy.mockRestore();
  });

  it("toggle exposes aria-expanded so disclosure state is announced", async () => {
    const user = userEvent.setup({ delay: null });
    render(<ProcessInfoPanel pane={pane()} />);
    const toggle = screen.getByTestId("loops-process-info-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("refresh button has an accessible name (aria-label)", async () => {
    const user = userEvent.setup({ delay: null });
    render(<ProcessInfoPanel pane={pane()} />);
    await user.click(screen.getByTestId("loops-process-info-toggle"));
    expect(
      screen.getByRole("button", { name: "Refresh process tree" }),
    ).toBeInTheDocument();
  });

  it("renders process rows when expanded with children", async () => {
    setInvokeHandlers(api, {
      "tmux:pane-processes": (): PaneProcesses => ({
        ...emptyProcesses(pane()),
        children: [
          {
            pid: 4242,
            ppid: 1234,
            comm: "claude",
            args: "/usr/local/bin/claude",
            elapsed: "01:02",
            cpuTime: "00:03",
          },
        ],
      }),
    });
    const user = userEvent.setup({ delay: null });
    render(<ProcessInfoPanel pane={pane()} />);
    await waitFor(() =>
      expect(screen.getByTestId("loops-process-info-toggle")).toHaveTextContent(
        "1 child process",
      ),
    );
    await user.click(screen.getByTestId("loops-process-info-toggle"));
    expect(screen.getByText("4242")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });
});
