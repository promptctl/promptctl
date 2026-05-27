import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { setupUser } from "../../test/user-event";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import type { VersionInfo } from "../../shared/types";

function makeVersions(count: number): VersionInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i + 1,
    ts: `2025-01-0${i + 1}T00:00:00Z`,
    label: `Version ${i + 1}`,
    sizeBytes: 1024 * (i + 1),
    tokensTotal: 100 * (i + 1),
  }));
}

describe("VersionHistoryPanel", () => {
  it("renders empty state when no versions", () => {
    render(
      <VersionHistoryPanel
        versions={[]}
        head={0}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByText(/no versions yet/i)).toBeTruthy();
    cleanup();
  });

  it("renders versions newest-first", () => {
    render(
      <VersionHistoryPanel
        versions={makeVersions(3)}
        head={3}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    const items = screen.getAllByTestId(/^version-item-/);
    expect(items).toHaveLength(3);
    // First rendered should be v3 (newest)
    expect(items[0].getAttribute("data-testid")).toBe("version-item-3");
    expect(items[1].getAttribute("data-testid")).toBe("version-item-2");
    expect(items[2].getAttribute("data-testid")).toBe("version-item-1");
    cleanup();
  });

  it("highlights the current head version", () => {
    render(
      <VersionHistoryPanel
        versions={makeVersions(3)}
        head={2}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByTestId("version-current-2")).toBeTruthy();
    expect(screen.queryByTestId("version-current-1")).toBeNull();
    expect(screen.queryByTestId("version-current-3")).toBeNull();
    cleanup();
  });

  it("displays label, tokens, and size", () => {
    render(
      <VersionHistoryPanel
        versions={makeVersions(1)}
        head={1}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByText("Version 1")).toBeTruthy();
    expect(screen.getByText(/100 tok/)).toBeTruthy();
    expect(screen.getByText(/1\.0 KB/)).toBeTruthy();
    cleanup();
  });

  it("Click 'View diff' calls onViewDiff with (idx, head)", async () => {
    const onViewDiff = vi.fn();
    const user = setupUser();
    render(
      <VersionHistoryPanel
        versions={makeVersions(3)}
        head={3}
        onClose={vi.fn()}
        onViewDiff={onViewDiff}
        onRestore={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("version-diff-1"));
    expect(onViewDiff).toHaveBeenCalledWith(1, 3);
    cleanup();
  });

  it("Click 'Restore' calls onRestore with idx", async () => {
    const onRestore = vi.fn();
    const user = setupUser();
    render(
      <VersionHistoryPanel
        versions={makeVersions(3)}
        head={3}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRestore={onRestore}
      />,
    );
    await user.click(screen.getByTestId("version-restore-1"));
    expect(onRestore).toHaveBeenCalledWith(1);
    cleanup();
  });

  it("disables 'View diff' and 'Restore' on the current head", () => {
    render(
      <VersionHistoryPanel
        versions={makeVersions(3)}
        head={2}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId("version-diff-2") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("version-restore-2") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("version-diff-1") as HTMLButtonElement).disabled,
    ).toBe(false);
    cleanup();
  });

  it("Click close calls onClose", async () => {
    const onClose = vi.fn();
    const user = setupUser();
    render(
      <VersionHistoryPanel
        versions={makeVersions(1)}
        head={1}
        onClose={onClose}
        onViewDiff={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("version-history-close"));
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });
});
