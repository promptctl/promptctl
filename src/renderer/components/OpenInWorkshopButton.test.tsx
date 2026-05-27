// [LAW:dataflow-not-control-flow] The button's render/click behavior is
// a pure projection of two stores (proxy.clients + launches), reached
// through either of two entry shapes. These tests drive the data and
// observe the projection — no internal flag-flipping, no hook mocking.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientInfo } from "../../shared/proxy-events";
import type {
  Launch,
  LaunchId,
  LaunchRunning,
  PaneId,
  SessionId,
  WindowId,
} from "../../shared/types";
import { installElectronMock } from "../../test/electron-mock";
import { setupUser } from "../../test/user-event";
import { useLaunchStore } from "../store/launches";
import { useProxyStore } from "../store/proxy";
import { OpenInWorkshopButton } from "./OpenInWorkshopButton";

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
  return (
    <div data-testid="location">
      <span data-testid="location-pathname">{location.pathname}</span>
      <span data-testid="location-search">{location.search}</span>
    </div>
  );
}

function renderFromClient(clientId: string) {
  return render(
    <MemoryRouter initialEntries={["/live"]}>
      <Routes>
        <Route
          path="/live"
          element={<OpenInWorkshopButton clientId={clientId} />}
        />
        <Route path="/workshop" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderFromLaunch(launchId: LaunchId) {
  return render(
    <MemoryRouter initialEntries={["/loops"]}>
      <Routes>
        <Route
          path="/loops"
          element={<OpenInWorkshopButton launchId={launchId} />}
        />
        <Route path="/workshop" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  installElectronMock();
  useProxyStore.setState({ clients: new Map() });
  useLaunchStore.setState({ launches: [] });
});

afterEach(() => {
  useProxyStore.setState({ clients: new Map() });
  useLaunchStore.setState({ launches: [] });
});

describe("OpenInWorkshopButton — clientId entry", () => {
  it("renders nothing when the client has no launchId", () => {
    useProxyStore.setState({
      clients: new Map([["c-untagged", clientInfo({ launchId: null })]]),
    });
    renderFromClient("c-untagged");
    expect(screen.queryByTestId("open-in-workshop-button")).toBeNull();
  });

  it("renders nothing when launchId does not resolve to a known launch", () => {
    useProxyStore.setState({
      clients: new Map([["launch-L-1", clientInfo()]]),
    });
    useLaunchStore.setState({ launches: [] });
    renderFromClient("launch-L-1");
    expect(screen.queryByTestId("open-in-workshop-button")).toBeNull();
  });

  it("renders and navigates to /workshop?launchId=... when the lookup resolves", async () => {
    const user = setupUser();
    useProxyStore.setState({
      clients: new Map([["launch-L-1", clientInfo()]]),
    });
    useLaunchStore.setState({ launches: [launch()] });

    renderFromClient("launch-L-1");
    const button = screen.getByTestId("open-in-workshop-button");
    expect(button).toBeInTheDocument();
    await user.click(button);

    expect(screen.getByTestId("location-pathname").textContent).toBe(
      "/workshop",
    );
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?launchId=L-1",
    );
  });
});

describe("OpenInWorkshopButton — launchId entry", () => {
  it("renders nothing when the launchId is not in the registry", () => {
    useLaunchStore.setState({ launches: [] });
    renderFromLaunch("missing" as LaunchId);
    expect(screen.queryByTestId("open-in-workshop-button")).toBeNull();
  });

  it("renders and navigates when the launchId resolves", async () => {
    const user = setupUser();
    useLaunchStore.setState({ launches: [launch()] });

    renderFromLaunch("L-1" as LaunchId);
    await user.click(screen.getByTestId("open-in-workshop-button"));

    expect(screen.getByTestId("location-pathname").textContent).toBe(
      "/workshop",
    );
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?launchId=L-1",
    );
  });

  it("renders uniformly regardless of toolKind or status", () => {
    // [LAW:one-type-per-behavior] The button does not branch on
    // toolKind or status. Every launch row that resolves produces a
    // button; every row that doesn't, produces nothing.
    useLaunchStore.setState({
      launches: [
        launch({ launchId: "L-claude" as LaunchId, toolKind: "claude" }),
        launch({ launchId: "L-codex" as LaunchId, toolKind: "codex" }),
        launch({ launchId: "L-gemini" as LaunchId, toolKind: "gemini" }),
      ],
    });
    renderFromLaunch("L-codex" as LaunchId);
    expect(screen.getByTestId("open-in-workshop-button")).toBeInTheDocument();
  });
});
