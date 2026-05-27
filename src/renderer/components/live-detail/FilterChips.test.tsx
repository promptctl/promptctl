import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import type { RequestRecord } from "../../../shared/proxy-events";
import { setupUser } from "../../../test/user-event";
import { FilterChips, optionTestSuffix } from "./FilterChips";
import { emptyFilters, type RequestFilters } from "./filters";

function optId(key: string, value: string): string {
  return `filter-option-${key}-${optionTestSuffix(value)}`;
}

let user: UserEvent;

beforeEach(() => {
  cleanup();
  user = setupUser();
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
    await user.click(screen.getByTestId("filter-chip-models"));
    const menu = screen.getByTestId("filter-chip-menu-models");
    // Option testid is slug + short hash — collision-free across
    // distinct option values. Tests compose it via optionTestSuffix
    // to stay in sync with the component.
    expect(
      within(menu).getByTestId(optId("models", "claude-sonnet")),
    ).toBeTruthy();
    expect(
      within(menu).getByTestId(optId("models", "claude-opus")),
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
    await user.click(chip);
    const menu = screen.getByTestId("filter-chip-menu-models");
    const selected = within(menu).getByTestId(
      optId("models", "claude-sonnet"),
    );
    expect(selected.getAttribute("aria-checked")).toBe("true");
    await user.click(selected);
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
    await user.click(screen.getByTestId("filter-chip-statuses"));
    expect(screen.getByTestId("filter-chip-menu-statuses")).toBeTruthy();
    await user.click(screen.getByTestId("filter-chip-errors"));
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
    await user.click(screen.getByTestId("filter-chip-statuses"));
    await user.click(screen.getByTestId(optId("statuses", "success")));
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
    await user.click(clear);
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
    await user.click(chip);
    const menu = screen.getByTestId("filter-chip-menu-statuses");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("Status");
    const success = within(menu).getByTestId(optId("statuses", "success"));
    expect(success.getAttribute("role")).toBe("menuitemcheckbox");
    expect(success.getAttribute("aria-checked")).toBe("true");
    const error = within(menu).getByTestId(optId("statuses", "error"));
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
    await user.click(chip);
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
    await user.click(screen.getByTestId("filter-chip-statuses"));
    expect(screen.getByTestId("filter-chip-menu-statuses")).toBeTruthy();
    await user.click(screen.getByTestId("outside"));
    expect(screen.queryByTestId("filter-chip-menu-statuses")).toBeNull();
  });
});
