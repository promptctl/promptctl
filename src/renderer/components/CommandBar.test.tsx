import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  installElectronMock,
  setInvokeHandlers,
  type MockElectronAPI,
} from "../../test/electron-mock";
import type {
  Command,
  CommandId,
  PaneId,
  SessionId,
  TmuxPane,
  TmuxSnapshot,
  WindowId,
} from "../../shared/types";
import { usePaneSelectionStore } from "../store/pane-selection";
import { useCommandStore } from "../store/command";
import { clearHistory } from "../lib/composer-history";

const sendKeys = vi.fn(() => Promise.resolve({}));

vi.mock("../tmux/proxy", () => ({
  getTmuxProxy: () => ({ sendKeys }),
  useTopology: (): TmuxSnapshot => ({
    timestamp: 0,
    panes: [
      {
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
      } satisfies TmuxPane,
    ],
  }),
}));

// Import after the mock so the component sees the stubbed proxy.
import { CommandBar } from "./CommandBar";

const fireCommandMock: Mock = vi.fn();

let api: MockElectronAPI;

function seedCommands(commands: Command[]): void {
  useCommandStore.setState({ commands, events: [], fireCommand: fireCommandMock });
}

function selectPane(id: PaneId | null): void {
  usePaneSelectionStore.setState({ selectedPaneId: id });
}

beforeEach(() => {
  sendKeys.mockClear();
  fireCommandMock.mockClear();
  clearHistory();
  api = installElectronMock();
  setInvokeHandlers(api, {});
  selectPane("%1" as PaneId);
  seedCommands([]);
});

afterEach(() => {
  cleanup();
  selectPane(null);
  seedCommands([]);
});

describe("CommandBar", () => {
  it("submits on Enter with a trailing \\r and clears the input", async () => {
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "echo hi");
    await user.keyboard("{Enter}");
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("%1", "echo hi\r");
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("Shift+Enter inserts a newline and does NOT submit", async () => {
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "line2");
    expect(sendKeys).not.toHaveBeenCalled();
    expect(input.value).toBe("line1\nline2");
  });

  it("sends multi-line text with embedded newlines on Enter", async () => {
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "first");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "second");
    await user.keyboard("{Enter}");
    expect(sendKeys).toHaveBeenCalledWith("%1", "first\nsecond\r");
  });

  it("Up arrow recalls the previous submission; Down returns to draft", async () => {
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;

    await user.type(input, "first cmd");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe(""));

    await user.type(input, "second cmd");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe(""));

    input.focus();
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("second cmd");
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("first cmd");
    // Already at oldest — another Up stays put.
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("first cmd");

    await user.keyboard("{ArrowDown}");
    expect(input.value).toBe("second cmd");
    await user.keyboard("{ArrowDown}");
    // Past the newest = back to the draft (empty).
    expect(input.value).toBe("");
  });

  it("preserves a draft when Up enters history then Down exits", async () => {
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "old");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(input.value).toBe(""));
    await user.type(input, "draft");
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("old");
    await user.keyboard("{ArrowDown}");
    expect(input.value).toBe("draft");
  });

  it("composer textarea has an accessible name (aria-label)", () => {
    render(<CommandBar />);
    expect(
      screen.getByRole("textbox", { name: "Command composer" }),
    ).toBeInTheDocument();
  });

  it("logs and preserves the draft when a suggestion click's fireCommand rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fireCommandMock.mockImplementationOnce(() =>
      Promise.reject(new Error("ipc down")),
    );
    seedCommands([
      {
        id: "cmd-bad" as CommandId,
        name: "broken.command",
        target: { kind: "app", resource: "x" },
        action: { kind: "notify", message: "nope" },
        trigger: { kind: "manual" },
        enabled: true,
        lastRun: null,
        runCount: 0,
      },
    ]);
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "broken");
    // Suggestion dropdown shows broken.command. Click it.
    const suggestion = await screen.findByText("broken.command");
    await user.click(suggestion);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Draft preserved; the user can retry.
    expect(input.value).toBe("broken");
    spy.mockRestore();
  });

  it("logs and preserves the draft when sendKeys rejects (no unhandled rejection, no clear)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendKeys.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "echo nope");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Input is preserved so the user can retry.
    expect(input.value).toBe("echo nope");
    spy.mockRestore();
  });

  it("fires an exact command match even when no pane is selected", async () => {
    selectPane(null);
    const user = userEvent.setup({ delay: null });
    seedCommands([
      {
        id: "cmd-app" as CommandId,
        name: "app.notify",
        target: { kind: "app", resource: "growl" },
        action: { kind: "notify", message: "hi" },
        trigger: { kind: "manual" },
        enabled: true,
        lastRun: null,
        runCount: 0,
      },
    ]);
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "app.notify");
    await user.keyboard("{Enter}");
    expect(fireCommandMock).toHaveBeenCalledWith("cmd-app");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("does NOT call sendKeys when there's no pane and no command match", async () => {
    selectPane(null);
    const user = userEvent.setup({ delay: null });
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "ls -la");
    await user.keyboard("{Enter}");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("fires an exact command match instead of sending to the pane", async () => {
    const user = userEvent.setup({ delay: null });
    seedCommands([
      {
        id: "cmd-1" as CommandId,
        name: "claude.poll",
        target: { kind: "tmux-pane", paneId: "%1" as PaneId },
        action: { kind: "send-keys", text: "/status", pressEnter: true },
        trigger: { kind: "manual" },
        enabled: true,
        lastRun: null,
        runCount: 0,
      },
    ]);
    render(<CommandBar />);
    const input = screen.getByTestId("loops-composer-input") as HTMLTextAreaElement;
    await user.type(input, "claude.poll");
    await user.keyboard("{Enter}");
    expect(fireCommandMock).toHaveBeenCalledWith("cmd-1");
    expect(sendKeys).not.toHaveBeenCalled();
  });
});
