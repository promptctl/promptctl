import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { setupUser } from "../../test/user-event";
import { DiffViewer } from "./DiffViewer";
import type {
  DiffEntry,
  MessageSummary,
  VersionInfo,
} from "../../shared/types";

function makeMessage(
  index: number,
  type = "user",
  preview = "test message",
): MessageSummary {
  return {
    index,
    id: `m${index}`,
    type,
    timestamp: "",
    tokens: 100,
    preview,
    hasToolCalls: false,
    hasToolResults: false,
    toolNames: [],
    flags: [],
    extras: {},
  };
}

function makeVersion(idx: number, label = "v", tokens = 1000): VersionInfo {
  return {
    idx,
    ts: "2025-01-01T00:00:00Z",
    label,
    sizeBytes: 1024,
    tokensTotal: tokens,
  };
}

describe("DiffViewer", () => {
  it("renders header with from→to and label", () => {
    render(
      <DiffViewer
        fromVersion={makeVersion(1, "Initial")}
        toVersion={makeVersion(2, "Removed 5 messages")}
        entries={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/v1 → v2/)).toBeTruthy();
    expect(screen.getByText(/Removed 5 messages/)).toBeTruthy();
    cleanup();
  });

  it("shows token delta with color: red for increase", () => {
    render(
      <DiffViewer
        fromVersion={makeVersion(1, "v", 1000)}
        toVersion={makeVersion(2, "v", 3500)}
        entries={[]}
        onClose={vi.fn()}
      />,
    );
    const delta = screen.getByTestId("token-delta");
    expect(delta.textContent).toContain("+2.5k");
    expect(delta.className).toContain("text-red");
    cleanup();
  });

  it("shows token delta with color: green for decrease", () => {
    render(
      <DiffViewer
        fromVersion={makeVersion(1, "v", 5000)}
        toVersion={makeVersion(2, "v", 1500)}
        entries={[]}
        onClose={vi.fn()}
      />,
    );
    const delta = screen.getByTestId("token-delta");
    expect(delta.textContent).toContain("-3.5k");
    expect(delta.className).toContain("text-green");
    cleanup();
  });

  it("renders unchanged entries", () => {
    const entries: DiffEntry[] = [{ kind: "unchanged", count: 7 }];
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={entries}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("diff-unchanged")).toBeTruthy();
    expect(screen.getByText(/7 messages unchanged/)).toBeTruthy();
    cleanup();
  });

  it("renders removed entries with message previews", () => {
    const entries: DiffEntry[] = [
      {
        kind: "removed",
        messages: [
          makeMessage(0, "assistant", "this was removed"),
          makeMessage(1, "user", "and so was this"),
        ],
      },
    ];
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={entries}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("diff-removed")).toBeTruthy();
    expect(screen.getByText(/− Removed \(2\)/)).toBeTruthy();
    expect(screen.getByText("this was removed")).toBeTruthy();
    expect(screen.getByText("and so was this")).toBeTruthy();
    cleanup();
  });

  it("renders added entries with message previews", () => {
    const entries: DiffEntry[] = [
      {
        kind: "added",
        messages: [makeMessage(2, "assistant", "fresh content")],
      },
    ];
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={entries}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("diff-added")).toBeTruthy();
    expect(screen.getByText(/\+ Added \(1\)/)).toBeTruthy();
    expect(screen.getByText("fresh content")).toBeTruthy();
    cleanup();
  });

  it("renders modified entries with token delta and expandable content", async () => {
    const before = makeMessage(0, "user", "original text");
    before.tokens = 8500;
    const after = makeMessage(0, "user", "modified text");
    after.tokens = 200;

    const entries: DiffEntry[] = [{ kind: "modified", before, after }];
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={entries}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("diff-modified")).toBeTruthy();

    // Token delta visible by default
    const delta = screen.getByTestId("modified-token-delta");
    expect(delta.textContent).toContain("8500");
    expect(delta.textContent).toContain("200");
    expect(delta.textContent).toContain("−8300 tokens");
    // Green for token reduction
    expect(delta.className).toContain("text-green");

    // Content is hidden by default — click "Show content" to reveal
    expect(screen.queryByText("original text")).toBeNull();
    expect(screen.queryByText("modified text")).toBeNull();

    const user = setupUser();
    await user.click(screen.getByText("Show content"));

    expect(screen.getByText("original text")).toBeTruthy();
    expect(screen.getByText("modified text")).toBeTruthy();
    cleanup();
  });

  it("modified token delta is red when tokens increased", () => {
    const before = makeMessage(0, "user", "short");
    before.tokens = 100;
    const after = makeMessage(0, "user", "longer");
    after.tokens = 300;

    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={[{ kind: "modified", before, after }]}
        onClose={vi.fn()}
      />,
    );
    const delta = screen.getByTestId("modified-token-delta");
    expect(delta.textContent).toContain("+200 tokens");
    expect(delta.className).toContain("text-red");
    cleanup();
  });

  it("renders multiple kinds of entries together", () => {
    const entries: DiffEntry[] = [
      { kind: "unchanged", count: 3 },
      { kind: "removed", messages: [makeMessage(0, "user", "rm")] },
      { kind: "added", messages: [makeMessage(1, "assistant", "add")] },
    ];
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={entries}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("diff-unchanged")).toBeTruthy();
    expect(screen.getByTestId("diff-removed")).toBeTruthy();
    expect(screen.getByTestId("diff-added")).toBeTruthy();
    cleanup();
  });

  it("Click close calls onClose", async () => {
    const onClose = vi.fn();
    const user = setupUser();
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={[]}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId("diff-close"));
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });

  it("Click backdrop calls onClose", async () => {
    const onClose = vi.fn();
    const user = setupUser();
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={[]}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId("diff-viewer"));
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });

  it("renders empty state when entries is empty", () => {
    render(
      <DiffViewer
        fromVersion={makeVersion(1)}
        toVersion={makeVersion(2)}
        entries={[]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/no differences/i)).toBeTruthy();
    cleanup();
  });
});
