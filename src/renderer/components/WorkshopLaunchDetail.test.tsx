// [LAW:dataflow-not-control-flow] The detail view composes projections
// from three stores (launches, proxy clients/requests, topology). These
// tests drive those projections and observe rendering — no internal
// flag-flipping, no per-launch branching to assert.
//
// [LAW:single-enforcer] launch:terminate is invoked through the same
// IPC channel the main-side handler registers. The test verifies the
// invoke call shape but does not reach into the handler's internals.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@promptctl/pane-terminal/react` would mount a real xterm.js terminal —
// useful in integration tests, but for these unit tests we only care
// that the component is invoked with the right shape. Mock it to a
// thin placeholder so jsdom doesn't fight xterm rendering.
vi.mock("@promptctl/pane-terminal/react", () => ({
  PaneTerminal: ({ stream }: { stream: unknown }) => (
    <div data-testid="pane-terminal-mock" data-has-stream={stream !== null} />
  ),
}));

import type { ClientInfo, RequestRecord } from "../../shared/proxy-events";
import type {
  LaunchExited,
  LaunchId,
  LaunchRunning,
  PaneId,
  SessionId,
  TmuxPane,
  WindowId,
} from "../../shared/types";
import {
  installElectronMock,
  setInvokeHandlers,
} from "../../test/electron-mock";
import { setupUser } from "../../test/user-event";
import { useLaunchStore } from "../store/launches";
import { useProxyStore } from "../store/proxy";
import { WorkshopLaunchDetail } from "./WorkshopLaunchDetail";

// `useTopology` and `usePaneStream` are renderer hooks that wire to the
// main-side tmux bridge. In a unit test we don't have a real bridge,
// so we stub them out at the module boundary — the same seam every
// component-tests that needs topology data uses. We can't reach into
// `useTopology` without an electron mock that responds to
// `tmux:topology:get`, so this is simpler.
vi.mock("../tmux/proxy", () => ({
  useTopology: () => ({ timestamp: 0, panes: mockTopologyPanes }),
  usePaneStream: () => ({ /* mock stream */ }),
}));

let mockTopologyPanes: TmuxPane[] = [];

function tmuxPane(over: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: "%17" as PaneId,
    sessionName: "promptctl-L-1",
    sessionId: "$3" as SessionId,
    windowName: "claude",
    windowId: "@5" as WindowId,
    windowIndex: 0,
    paneIndex: 0,
    pid: 42,
    currentCommand: "claude",
    currentPath: "/repo",
    width: 80,
    height: 24,
    active: true,
    toolKind: "claude",
    ...over,
  };
}

function runningLaunch(over: Partial<LaunchRunning> = {}): LaunchRunning {
  return {
    launchId: "L-1" as LaunchId,
    toolKind: "claude",
    paneId: "%17" as PaneId,
    sessionId: "$3" as SessionId,
    windowId: "@5" as WindowId,
    cwd: "/repo",
    startedAt: 1,
    env: {},
    status: "running",
    pid: 42,
    proxyClientId: null,
    sessionFilePath: null,
    ...over,
  };
}

function exitedLaunch(over: Partial<LaunchExited> = {}): LaunchExited {
  return {
    launchId: "L-1" as LaunchId,
    toolKind: "claude",
    paneId: "%17" as PaneId,
    sessionId: "$3" as SessionId,
    windowId: "@5" as WindowId,
    cwd: "/repo",
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

function clientInfo(over: Partial<ClientInfo> = {}): ClientInfo {
  return {
    clientId: "launch-L-1",
    pid: 42,
    rootPid: 42,
    displayName: "claude",
    command: "claude",
    cwd: "/repo",
    lastSeenNs: 1,
    launchId: "L-1" as LaunchId,
    ...over,
  };
}

function requestRecord(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: "r-1",
    clientId: "launch-L-1",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    startedNs: 1,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: null,
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
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

function renderDetail(launchId: LaunchId) {
  return render(
    <MemoryRouter initialEntries={[`/workshop?launchId=${launchId}`]}>
      <Routes>
        <Route
          path="/workshop"
          element={<WorkshopLaunchDetail launchId={launchId} />}
        />
        <Route path="/loops" element={<LocationProbe />} />
        <Route path="/context-workshop" element={<LocationProbe />} />
        <Route path="/live" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  installElectronMock();
  useLaunchStore.setState({ launches: [] });
  useProxyStore.setState({ clients: new Map(), requests: new Map() });
  mockTopologyPanes = [];
});

afterEach(() => {
  useLaunchStore.setState({ launches: [] });
  useProxyStore.setState({ clients: new Map(), requests: new Map() });
});

describe("WorkshopLaunchDetail — missing launch", () => {
  it("shows a not-found state when the launchId is not in the registry", () => {
    renderDetail("L-missing" as LaunchId);
    expect(screen.getByText(/Launch not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId("workshop-pane-terminal")).toBeNull();
  });
});

describe("WorkshopLaunchDetail — pane projection", () => {
  it("renders the pane terminal when the launch's paneId is present in topology", () => {
    useLaunchStore.setState({ launches: [runningLaunch()] });
    mockTopologyPanes = [tmuxPane()];
    renderDetail("L-1" as LaunchId);
    expect(screen.getByTestId("workshop-pane-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("pane-terminal-mock")).toBeInTheDocument();
  });

  it("shows the pane-missing placeholder when topology does not carry the paneId", () => {
    useLaunchStore.setState({ launches: [runningLaunch()] });
    mockTopologyPanes = []; // pane absent
    renderDetail("L-1" as LaunchId);
    expect(screen.getByTestId("workshop-pane-missing")).toBeInTheDocument();
    expect(screen.queryByTestId("workshop-pane-terminal")).toBeNull();
  });
});

describe("WorkshopLaunchDetail — requests projection", () => {
  it("projects only the launch's requests by launchId attribution", () => {
    useLaunchStore.setState({ launches: [runningLaunch()] });
    mockTopologyPanes = [tmuxPane()];
    // Two clients: one matches our launchId, one doesn't.
    useProxyStore.setState({
      clients: new Map([
        ["launch-L-1", clientInfo({ clientId: "launch-L-1" })],
        [
          "launch-other",
          clientInfo({
            clientId: "launch-other",
            launchId: "L-other" as LaunchId,
          }),
        ],
      ]),
      requests: new Map([
        ["r-mine", requestRecord({ requestId: "r-mine", clientId: "launch-L-1" })],
        [
          "r-theirs",
          requestRecord({
            requestId: "r-theirs",
            clientId: "launch-other",
            url: "https://api.anthropic.com/v1/other",
          }),
        ],
      ]),
    });
    renderDetail("L-1" as LaunchId);
    const rows = screen.getAllByTestId("workshop-request-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-request-id")).toBe("r-mine");
  });

  it("shows the empty-requests hint when no requests are attributed yet", () => {
    useLaunchStore.setState({ launches: [runningLaunch()] });
    mockTopologyPanes = [tmuxPane()];
    renderDetail("L-1" as LaunchId);
    expect(
      screen.getByText(/No requests attributed to this launch yet/i),
    ).toBeInTheDocument();
  });
});

describe("WorkshopLaunchDetail — session file panel", () => {
  it("shows the path when sessionFilePath is set", () => {
    useLaunchStore.setState({
      launches: [
        runningLaunch({ sessionFilePath: "/path/to/session.jsonl" }),
      ],
    });
    mockTopologyPanes = [tmuxPane()];
    renderDetail("L-1" as LaunchId);
    const panel = screen.getByTestId("workshop-session-file");
    expect(panel.getAttribute("data-session-file-path")).toBe(
      "/path/to/session.jsonl",
    );
  });

  it("shows a waiting hint when sessionFilePath is null on a running row", () => {
    useLaunchStore.setState({
      launches: [runningLaunch({ sessionFilePath: null })],
    });
    mockTopologyPanes = [tmuxPane()];
    renderDetail("L-1" as LaunchId);
    expect(
      screen.getByText(/No session file has appeared/i),
    ).toBeInTheDocument();
  });
});

describe("WorkshopLaunchDetail — Stop button", () => {
  it("invokes launch:terminate with the launchId when Stop is clicked", async () => {
    const api = installElectronMock();
    const terminate = vi.fn(async () => null);
    setInvokeHandlers(api, { "launch:terminate": terminate });
    useLaunchStore.setState({ launches: [runningLaunch()] });
    mockTopologyPanes = [tmuxPane()];

    renderDetail("L-1" as LaunchId);
    const user = setupUser();
    await user.click(screen.getByTestId("workshop-terminate"));

    expect(terminate).toHaveBeenCalledWith("L-1");
  });

  it("hides the Stop button on an exited launch — data, not branching on identity", () => {
    useLaunchStore.setState({ launches: [exitedLaunch()] });
    renderDetail("L-1" as LaunchId);
    expect(screen.queryByTestId("workshop-terminate")).toBeNull();
  });
});

describe("WorkshopLaunchDetail — cross-tab navigation", () => {
  it("Open pane in Loops navigates to /loops", async () => {
    useLaunchStore.setState({ launches: [runningLaunch()] });
    mockTopologyPanes = [tmuxPane()];
    renderDetail("L-1" as LaunchId);
    const user = setupUser();
    await user.click(screen.getByTestId("workshop-open-in-loops"));
    expect(screen.getByTestId("location-pathname").textContent).toBe("/loops");
  });
});
