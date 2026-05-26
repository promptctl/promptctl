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
    // Every chip exists — testid is the stable FilterKey, not the
    // user-facing label.
    for (const k of ["models", "statuses", "toolUse", "errors", "sizeBuckets"]) {
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
    const modelChip = screen.getByTestId("filter-chip-models");
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
    expect(screen.getByTestId("filter-chip-models")).not.toBeDisabled();
    await userEvent.click(screen.getByTestId("filter-chip-models"));
    const menu = screen.getByTestId("filter-chip-menu-models");
    // Option testid slug-encodes the option value to be selector-safe.
    expect(
      within(menu).getByTestId("filter-option-models-claude-sonnet"),
    ).toBeTruthy();
    expect(
      within(menu).getByTestId("filter-option-models-claude-opus"),
    ).toBeTruthy();
  });

  it("keeps Model chip enabled when filters.models has selections even if no records are observed", async () => {
    // The bug this guards against: records vanish (client switch,
    // Clear events) while filters.models retains selections. The
    // chip used to disable itself out from under those selections,
    // leaving the user no way to deselect short of Clear filters.
    const onToggle = vi.fn();
    render(
      <FilterChips
        records={[]}
        filters={f({ models: new Set(["claude-sonnet"]) })}
        onToggle={onToggle}
        onClear={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("filter-chip-models");
    expect(chip).not.toBeDisabled();
    expect(chip.getAttribute("data-active")).toBe("true");
    // The selected-but-unobserved value is in the option list so it
    // can be toggled off.
    await userEvent.click(chip);
    const menu = screen.getByTestId("filter-chip-menu-models");
    const selected = within(menu).getByTestId(
      "filter-option-models-claude-sonnet",
    );
    expect(selected.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(selected);
    expect(onToggle).toHaveBeenCalledWith("models", "claude-sonnet");
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
    await userEvent.click(screen.getByTestId("filter-chip-statuses"));
    expect(screen.getByTestId("filter-chip-menu-statuses")).toBeTruthy();
    await userEvent.click(screen.getByTestId("filter-chip-errors"));
    expect(screen.queryByTestId("filter-chip-menu-statuses")).toBeNull();
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
    await userEvent.click(screen.getByTestId("filter-chip-statuses"));
    await userEvent.click(screen.getByTestId("filter-option-statuses-success"));
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
    const single = screen.getByTestId("filter-chip-statuses");
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
    expect(screen.getByTestId("filter-chip-statuses").textContent).toContain(
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

  it("uses the menu + menuitemcheckbox a11y pattern for the dropdown", async () => {
    render(
      <FilterChips
        records={[record()]}
        filters={f({ statuses: new Set(["success"]) })}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("filter-chip-statuses");
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    await userEvent.click(chip);
    const menu = screen.getByTestId("filter-chip-menu-statuses");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("Status");
    const success = within(menu).getByTestId("filter-option-statuses-success");
    expect(success.getAttribute("role")).toBe("menuitemcheckbox");
    expect(success.getAttribute("aria-checked")).toBe("true");
    const error = within(menu).getByTestId("filter-option-statuses-error");
    expect(error.getAttribute("role")).toBe("menuitemcheckbox");
    expect(error.getAttribute("aria-checked")).toBe("false");
  });

  it("auto-closes the Model chip when records dry up AND no selections remain", async () => {
    // With no selections, an empty record set should both disable
    // the chip AND auto-close any open menu so aria-expanded /
    // suppressed-popup don't disagree.
    const { rerender } = render(
      <FilterChips
        records={[record({ requestBody: { model: "claude-sonnet" } })]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("filter-chip-models");
    expect(chip).not.toBeDisabled();
    await userEvent.click(chip);
    expect(screen.getByTestId("filter-chip-menu-models")).toBeTruthy();
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    rerender(
      <FilterChips
        records={[]}
        filters={emptyFilters()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const chipAfter = screen.getByTestId("filter-chip-models");
    expect(chipAfter).toBeDisabled();
    expect(chipAfter.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("filter-chip-menu-models")).toBeNull();
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
    await userEvent.click(screen.getByTestId("filter-chip-statuses"));
    expect(screen.getByTestId("filter-chip-menu-statuses")).toBeTruthy();
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByTestId("filter-chip-menu-statuses")).toBeNull();
  });
});
