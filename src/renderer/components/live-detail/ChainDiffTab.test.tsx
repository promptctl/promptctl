import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import { ChainDiffTab } from "./ChainDiffTab";

beforeEach(() => cleanup());

function rec(
  id: string,
  body: { system?: unknown; tools?: unknown[] | null },
): RequestRecord {
  return {
    requestId: id,
    clientId: "client-x",
    method: "POST",
    url: "https://api.example.test/v1/messages",
    status: 200,
    startedNs: 1,
    firstByteNs: null,
    completedNs: null,
    endedNs: null,
    requestBody: {
      model: "claude-test",
      system: body.system,
      tools: body.tools ?? undefined,
      messages: [],
    },
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
  };
}

describe("ChainDiffTab", () => {
  it("renders both sections with the right version counts for a chain that evolves both", () => {
    const chain = [
      rec("aaaaaaaa", { system: "Sys A", tools: [{ name: "Bash" }] }),
      rec("bbbbbbbb", {
        system: "Sys A",
        tools: [{ name: "Bash" }, { name: "Read" }],
      }),
      rec("cccccccc", {
        system: "Sys B",
        tools: [{ name: "Bash" }, { name: "Read" }],
      }),
      rec("dddddddd", {
        system: "Sys B",
        tools: [{ name: "Bash" }, { name: "Read" }, { name: "Write" }],
      }),
    ];
    render(
      <ChainDiffTab chain={chain} selectedRequestId="cccccccc" />,
    );

    const systemSection = screen.getByTestId("chain-diff-system");
    const toolsSection = screen.getByTestId("chain-diff-tools");

    expect(
      within(systemSection).getAllByTestId("chain-diff-system-card"),
    ).toHaveLength(2);
    expect(
      within(toolsSection).getAllByTestId("chain-diff-tools-card"),
    ).toHaveLength(3);

    // First system version has no diff slot (it's the baseline); the
    // second one does.
    expect(
      within(systemSection).getAllByTestId("chain-diff-system-diff"),
    ).toHaveLength(1);
    // Tools: two diff slots between three versions.
    expect(
      within(toolsSection).getAllByTestId("chain-diff-tools-diff"),
    ).toHaveLength(2);
  });

  it("renders the addition that introduced the new system text inside the diff slot", () => {
    const chain = [
      rec("a1", { system: "You are Claude." }),
      rec("a2", {
        system: "You are Claude.\nYou may now call the search tool.",
      }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="a2" />);
    const diff = within(screen.getByTestId("chain-diff-system")).getByTestId(
      "chain-diff-system-diff",
    );
    expect(diff).toHaveTextContent("You may now call the search tool.");
  });

  it("flags added / removed / changed tools in the tools diff", () => {
    const chain = [
      rec("a1", {
        system: "x",
        tools: [
          { name: "Bash", description: "old" },
          { name: "Removed" },
        ],
      }),
      rec("a2", {
        system: "x",
        tools: [
          { name: "Bash", description: "new" },
          { name: "Added" },
        ],
      }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="a2" />);
    expect(screen.getByTestId("chain-diff-tools-added")).toHaveTextContent("Added");
    expect(screen.getByTestId("chain-diff-tools-removed")).toHaveTextContent(
      "Removed",
    );
    expect(screen.getByTestId("chain-diff-tools-changed")).toHaveTextContent(
      "Bash",
    );
  });

  it("highlights the version run containing the selected request", () => {
    const chain = [
      rec("a1", { system: "Sys A" }),
      rec("a2", { system: "Sys B" }),
      rec("a3", { system: "Sys B" }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="a3" />);
    const cards = within(screen.getByTestId("chain-diff-system")).getAllByTestId(
      "chain-diff-system-card",
    );
    expect(cards[0]).toHaveAttribute("data-selected", "false");
    expect(cards[1]).toHaveAttribute("data-selected", "true");
    // a3 is in the second run; its presence in requestIds drives selection.
    expect(cards[1]).toHaveTextContent("a3");
  });

  it("highlights only the chip matching selectedRequestId within a run", () => {
    const chain = [
      rec("aaaaaa", { system: "Sys A" }),
      rec("bbbbbb", { system: "Sys A" }),
      rec("cccccc", { system: "Sys A" }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="bbbbbb" />);
    const chips = screen.getAllByTestId("chain-diff-request-chip");
    const systemChips = chips.slice(0, 3);
    expect(systemChips[0].className).not.toContain("bg-cyan-900");
    expect(systemChips[1].className).toContain("bg-cyan-900");
    expect(systemChips[2].className).not.toContain("bg-cyan-900");
  });

  it("emits onSelectRequest when a request chip is clicked", () => {
    const chain = [
      rec("a1", { system: "Sys A" }),
      rec("a2", { system: "Sys B" }),
    ];
    const onSelect = vi.fn();
    render(
      <ChainDiffTab
        chain={chain}
        selectedRequestId="a1"
        onSelectRequest={onSelect}
      />,
    );
    const chips = screen.getAllByTestId("chain-diff-request-chip");
    fireEvent.click(chips[1]);
    expect(onSelect).toHaveBeenCalledWith("a2");
  });

  it("reports 'no changes across chain' when system never changes", () => {
    const chain = [
      rec("a1", { system: "stable" }),
      rec("a2", { system: "stable" }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="a1" />);
    const systemSection = screen.getByTestId("chain-diff-system");
    expect(systemSection).toHaveTextContent("no changes across chain");
    expect(
      within(systemSection).queryAllByTestId("chain-diff-system-diff"),
    ).toHaveLength(0);
  });

  it("shows the AABA pattern as three distinct system runs", () => {
    const chain = [
      rec("a1", { system: "prompt A" }),
      rec("a2", { system: "prompt A" }),
      rec("a3", { system: "prompt B" }),
      rec("a4", { system: "prompt A" }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="a4" />);
    const cards = within(screen.getByTestId("chain-diff-system")).getAllByTestId(
      "chain-diff-system-card",
    );
    expect(cards).toHaveLength(3);
    // a4 lives in the third run (flickered-back to A); the third card
    // is the selected one.
    expect(cards[2]).toHaveAttribute("data-selected", "true");
  });

  it("renders an empty-state hint for a null/empty chain", () => {
    render(<ChainDiffTab chain={null} selectedRequestId="x" />);
    expect(screen.getByTestId("chain-diff-empty")).toBeInTheDocument();
  });

  it("expands a version body when the version-hash button is clicked", () => {
    const chain = [
      rec("a1", { system: "Sys A" }),
      rec("a2", { system: "Sys B" }),
    ];
    render(<ChainDiffTab chain={chain} selectedRequestId="a1" />);
    const systemSection = screen.getByTestId("chain-diff-system");
    expect(
      within(systemSection).queryAllByTestId("chain-diff-system-body"),
    ).toHaveLength(0);
    const toggles = within(systemSection).getAllByTestId(
      "chain-diff-system-toggle",
    );
    fireEvent.click(toggles[0]);
    expect(
      within(systemSection).getAllByTestId("chain-diff-system-body"),
    ).toHaveLength(1);
  });
});
