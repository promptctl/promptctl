import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installElectronMock, setInvokeHandlers } from "../../test/electron-mock";
import type { TmuxSnapshot } from "../../shared/types";
import type { TmuxControlState } from "../env";
import { TmuxControlDebug } from "./TmuxControlDebug";

const EMPTY_TOPOLOGY: TmuxSnapshot = { timestamp: 0, panes: [] };

beforeEach(() => {
  const api = installElectronMock();
  // Default: a closed connection seeded by the get handler. Individual tests
  // override.
  setInvokeHandlers(api, {
    "tmux:control-state:get": (): TmuxControlState => ({
      status: "closed",
      reason: "no tmux server",
      reconnectAttempts: 0,
    }),
    "tmux:topology:get": (): TmuxSnapshot => EMPTY_TOPOLOGY,
  });
});

afterEach(() => {
  // installElectronMock overwrites for the next test; nothing to tear down.
});

describe("TmuxControlDebug", () => {
  it("renders the seeded connection state from tmux:control-state:get", async () => {
    render(<TmuxControlDebug />);

    await waitFor(() => {
      expect(screen.getByTestId("control-status")).toHaveTextContent("closed");
    });
    expect(screen.getByTestId("control-reason")).toHaveTextContent(
      "no tmux server",
    );
    expect(screen.getByTestId("control-reconnect-attempts")).toHaveTextContent(
      "0",
    );
  });

  it("updates each field on a tmux:control-state broadcast", async () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:control-state:get": (): TmuxControlState => ({
        status: "connecting",
        reconnectAttempts: 0,
      }),
      "tmux:topology:get": (): TmuxSnapshot => EMPTY_TOPOLOGY,
    });

    render(<TmuxControlDebug />);

    await waitFor(() => {
      expect(screen.getByTestId("control-status")).toHaveTextContent(
        "connecting",
      );
    });

    act(() => {
      api.emit("tmux:control-state", {
        status: "ready",
        reconnectAttempts: 0,
      } satisfies TmuxControlState);
    });

    expect(screen.getByTestId("control-status")).toHaveTextContent("ready");
    expect(screen.getByTestId("control-reason")).toHaveTextContent("—");

    act(() => {
      api.emit("tmux:control-state", {
        status: "closed",
        reason: "transport closed",
        reconnectAttempts: 3,
      } satisfies TmuxControlState);
    });

    expect(screen.getByTestId("control-status")).toHaveTextContent("closed");
    expect(screen.getByTestId("control-reason")).toHaveTextContent(
      "transport closed",
    );
    expect(screen.getByTestId("control-reconnect-attempts")).toHaveTextContent(
      "3",
    );
  });

  it("shows '—' for missing reason", async () => {
    const api = installElectronMock();
    setInvokeHandlers(api, {
      "tmux:control-state:get": (): TmuxControlState => ({
        status: "ready",
        reconnectAttempts: 0,
      }),
      "tmux:topology:get": (): TmuxSnapshot => EMPTY_TOPOLOGY,
    });

    render(<TmuxControlDebug />);

    await waitFor(() => {
      expect(screen.getByTestId("control-status")).toHaveTextContent("ready");
    });
    expect(screen.getByTestId("control-reason")).toHaveTextContent("—");
  });
});
