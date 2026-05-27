// [LAW:dataflow-not-control-flow] The button's render/click behavior is
// a pure projection of two stores. These tests drive the data and
// observe the projection — no internal flag-flipping, no mocking the
// hooks themselves.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientInfo } from "../../../shared/proxy-events";
import type {
  Launch,
  LaunchId,
  LaunchRunning,
  PaneId,
  SessionId,
  WindowId,
} from "../../../shared/types";
import { installElectronMock } from "../../../test/electron-mock";
import { setupUser } from "../../../test/user-event";
import { useLaunchStore } from "../../store/launches";
import { usePaneSelectionStore } from "../../store/pane-selection";
import { useProxyStore } from "../../store/proxy";
import { OpenPaneButton } from "./OpenPaneButton";

function clientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    clientId: "launch-L-1",
    pid: 1234,
    rootPid: 1234,
    displayName: "claude @ repo",
    command: "claude",
    cwd: "/repo",
    lastSeenNs: 1,
    launchId: "L-1" as LaunchId,
    ...overrides,
  };
}

// The helper keeps `status: "running"` so the return is concrete in the
// LaunchRunning arm of the union. Tests that need other statuses build
// them inline rather than overriding `status` here.
function launch(overrides: Partial<LaunchRunning> = {}): Launch {
  const base: LaunchRunning = {
    launchId: "L-1" as LaunchId,
    toolKind: "claude",
    paneId: "%17" as PaneId,
    sessionId: "$3" as SessionId,
    windowId: "@5" as WindowId,
    cwd: "/repo",
    startedAt: 1,
    env: {},
    status: "running",
    pid: 1234,
    proxyClientId: null,
    sessionFilePath: null,
  };
  return { ...base, ...overrides };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-pathname">{location.pathname}</div>;
}

function renderButton(clientId: string) {
  return render(
    <MemoryRouter initialEntries={["/live"]}>
      <Routes>
        <Route path="/live" element={<OpenPaneButton clientId={clientId} />} />
        <Route path="/loops" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  installElectronMock();
  // [LAW:single-enforcer] Stores are module-singletons; reset before
  // each test so prior cases don't bleed in.
  useProxyStore.setState({ clients: new Map() });
  useLaunchStore.setState({ launches: [] });
  usePaneSelectionStore.setState({ selectedPaneId: null });
});

afterEach(() => {
  useProxyStore.setState({ clients: new Map() });
  useLaunchStore.setState({ launches: [] });
  usePaneSelectionStore.setState({ selectedPaneId: null });
});

describe("OpenPaneButton", () => {
  it("renders no button when the client has no launchId", () => {
    useProxyStore.setState({
      clients: new Map([["c-untagged", clientInfo({ launchId: null })]]),
    });
    renderButton("c-untagged");
    expect(screen.queryByTestId("open-pane-button")).toBeNull();
  });

  it("renders no button when the launchId does not map to a known launch (e.g. replay)", () => {
    useProxyStore.setState({
      clients: new Map([
        [
          "launch-replay-foo",
          clientInfo({
            clientId: "launch-replay-foo",
            launchId: "replay-foo" as LaunchId,
          }),
        ],
      ]),
    });
    useLaunchStore.setState({ launches: [] });
    renderButton("launch-replay-foo");
    expect(screen.queryByTestId("open-pane-button")).toBeNull();
  });

  it("renders the button when the client's launchId resolves to a launch row", () => {
    useProxyStore.setState({
      clients: new Map([["launch-L-1", clientInfo()]]),
    });
    useLaunchStore.setState({ launches: [launch()] });
    renderButton("launch-L-1");
    const button = screen.getByTestId("open-pane-button");
    expect(button).toHaveTextContent("Open pane");
    expect(button.getAttribute("title")).toContain("%17");
    expect(button.getAttribute("title")).toContain("claude");
  });

  it("selects the launch's pane and navigates to /loops when clicked", async () => {
    const user = setupUser();
    useProxyStore.setState({
      clients: new Map([["launch-L-1", clientInfo()]]),
    });
    useLaunchStore.setState({ launches: [launch()] });

    renderButton("launch-L-1");
    await user.click(screen.getByTestId("open-pane-button"));

    expect(usePaneSelectionStore.getState().selectedPaneId).toBe("%17");
    expect(screen.getByTestId("location-pathname").textContent).toBe("/loops");
  });
});
