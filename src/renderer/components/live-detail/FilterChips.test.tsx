import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RequestRecord } from "../../../shared/proxy-events";
import { FilterChips } from "./FilterChips";
import { emptyFilters, type RequestFilters } from "./filters";

beforeEach(() => {
  cleanup();
});

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: "r",
    clientId: "c",
    method: "POST",
    url: "https://api.example.test/r",
    status: 200,
    startedNs: 0,
    firstByteNs: 1,
    completedNs: 2,
    endedNs: 2,
    requestBody: { model: "claude-sonnet", messages: [] },
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
    ...overrides,
  };
}

function f(overrides: Partial<RequestFilters> = {}): RequestFilters {
  return { ...emptyFilters(), ...overrides };
}

describe("FilterChips", () => {
  it("renders one chip per category with 'any' when empty", () => {
    render(
      <FilterChips
        records={[record()]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    // Every chip exists.
    for (const k of ["model", "status", "tool-use", "errors", "size"]) {
      const chip = screen.getByTestId(`filter-chip-${k}`);
      expect(chip).toBeTruthy();
      expect(chip.textContent).toContain("any");
      expect(chip.getAttribute("data-active")).toBe("false");
    }
  });

  it("populates model options from observed records and disables when none", async () => {
    const { rerender } = render(
      <FilterChips
        records={[]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const modelChip = screen.getByTestId("filter-chip-model");
    expect(modelChip).toBeDisabled();

    rerender(
      <FilterChips
        records={[
          record({ requestBody: { model: "claude-sonnet" } }),
          record({ requestBody: { model: "claude-opus" } }),
        ]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByTestId("filter-chip-model")).not.toBeDisabled();
    await userEvent.click(screen.getByTestId("filter-chip-model"));
    const menu = screen.getByTestId("filter-chip-menu-model");
    expect(within(menu).getByTestId("filter-option-claude-sonnet")).toBeTruthy();
    expect(within(menu).getByTestId("filter-option-claude-opus")).toBeTruthy();
  });

  it("opening one chip closes the others", async () => {
    render(
      <FilterChips
        records={[record()]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("filter-chip-status"));
    expect(screen.getByTestId("filter-chip-menu-status")).toBeTruthy();
    await userEvent.click(screen.getByTestId("filter-chip-errors"));
    expect(screen.queryByTestId("filter-chip-menu-status")).toBeNull();
    expect(screen.getByTestId("filter-chip-menu-errors")).toBeTruthy();
  });

  it("calls onToggle with the typed (key, value) pair when an option is chosen", async () => {
    const onToggle = vi.fn();
    render(
      <FilterChips
        records={[record()]}
        filters={emptyFilters()}
        onToggle={onToggle}
        onClear={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("filter-chip-status"));
    await userEvent.click(screen.getByTestId("filter-option-success"));
    expect(onToggle).toHaveBeenCalledWith("statuses", "success");
  });

  it("summarizes selection: '1 selected' is shown as the option name; >1 as 'N selected'", () => {
    render(
      <FilterChips
        records={[record()]}
        filters={f({ statuses: new Set(["success"]) })}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const single = screen.getByTestId("filter-chip-status");
    expect(single.textContent).toContain("success");
    expect(single.getAttribute("data-active")).toBe("true");

    cleanup();
    render(
      <FilterChips
        records={[record()]}
        filters={f({ statuses: new Set(["success", "error"]) })}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByTestId("filter-chip-status").textContent).toContain(
      "2 selected",
    );
  });

  it("Clear filters is disabled when empty and calls onClear when active", async () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterChips
        records={[record()]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByTestId("filter-chips-clear")).toBeDisabled();
    rerender(
      <FilterChips
        records={[record()]}
        filters={f({ errors: new Set(["yes"]) })}
        onToggle={vi.fn()}
        onClear={onClear}
      />,
    );
    const clear = screen.getByTestId("filter-chips-clear");
    expect(clear).not.toBeDisabled();
    await userEvent.click(clear);
    expect(onClear).toHaveBeenCalled();
  });

  it("clicking outside the chip strip closes any open menu", async () => {
    render(
      <div>
        <FilterChips
          records={[record()]}
          filters={emptyFilters()}
          onToggle={vi.fn()}
          onClear={vi.fn()}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByTestId("filter-chip-status"));
    expect(screen.getByTestId("filter-chip-menu-status")).toBeTruthy();
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByTestId("filter-chip-menu-status")).toBeNull();
  });
});
