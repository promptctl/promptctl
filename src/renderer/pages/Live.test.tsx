import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Live } from "./Live";
import { useProxyStore } from "../store/proxy";
import type { ClientInfo, ProxyEvent } from "../../shared/proxy-events";
import { optionTestSuffix } from "../components/live-detail/FilterChips";
import { emptyFilters } from "../components/live-detail/filters";
import { installElectronMock } from "../../test/electron-mock";
import { setupUser } from "../../test/user-event";

// [LAW:locality-or-seam] Live embeds RequestDetail, whose OpenPaneButton
// calls useNavigate. Wrap in MemoryRouter so the hook resolves.
function renderLive(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Live />
    </MemoryRouter>,
  );
}

function optId(key: string, value: string): string {
  return `filter-option-${key}-${optionTestSuffix(value)}`;
}

beforeEach(() => {
  cleanup();
  installElectronMock();
  useProxyStore.setState({
    status: {
      running: true,
      port: 9999,
      upstreamTarget: "https://api.example.test",
      recordingPath: null,
      entryCount: 0,
    },
    requests: new Map(),
    clients: new Map(),
    selectedClientId: null,
    selectedRequestId: null,
    selectedPromptHash: null,
    filters: emptyFilters(),
    searchQuery: "",
    searchScope: "client",
  });
});

describe("Live", () => {
  it("renders grouped request rows, client tabs, filtering, and request detail pane", async () => {
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    state.upsertClient(client("client-b", "Codex @ app"));
    for (const event of [
      ...events("req-a", "client-a"),
      ...events("req-b", "client-b"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    expect(screen.getByText("Claude @ app")).toBeTruthy();
    expect(screen.getByText("Codex @ app")).toBeTruthy();
    expect(screen.getAllByText(/req-a/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/req-b/).length).toBeGreaterThan(0);
    const allTotals = screen.getByText("Totals · 2 requests").parentElement;
    expect(allTotals).not.toBeNull();
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-input"),
    ).toHaveTextContent("in30");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-cache-creation"),
    ).toHaveTextContent("cache+5");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-cache-read"),
    ).toHaveTextContent("cache·7");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-pill-output"),
    ).toHaveTextContent("out7");
    expect(
      within(allTotals as HTMLElement).getByTestId("usage-segment-cache-read"),
    ).toHaveAttribute("data-share", String(7 / 42));
    // The list pane lives inside a ResizableSplit; its outer container carries the
    // explicit pixel width so users can drag it.
    expect(screen.getByTestId("live-split-first")).toHaveStyle({
      width: "800px",
    });
    expect(screen.getAllByText(/req-a/)[0].closest("button")).toHaveClass(
      "grid-cols-[5rem_3.5rem_3.5rem_5rem_minmax(8rem,1fr)_28rem]",
    );

    const user = setupUser();
    await user.click(screen.getByText("Claude @ app"));
    expect(screen.getAllByText(/req-a/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/req-b/)).toBeNull();
    const clientTotals = screen.getByText("Totals · 1 request").parentElement;
    expect(clientTotals).not.toBeNull();
    expect(
      within(clientTotals as HTMLElement).getByTestId("usage-pill-input"),
    ).toHaveTextContent("in10");

    await user.click(screen.getByText("All"));
    await user.click(screen.getAllByText(/req-a/)[0]);
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText(/HTTP --/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Request" }));
    expect(screen.getAllByText(/claude-test/).length).toBeGreaterThan(0);

    await user.click(screen.getAllByText(/req-b/)[0]);
    expect(screen.getByText("Messages (1)")).toBeTruthy();
    expect(screen.getByText("hello req-b")).toBeTruthy();

    await user.click(screen.getAllByText(/req-b/)[0]);
    expect(
      screen.getByText("Select a request to inspect details."),
    ).toBeTruthy();
  });

  it("groups a 3-request lineage chain under one root with continuation markers and a Diff tab", async () => {
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    for (const event of chainEvents()) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    const rows = screen.getAllByTestId("live-request-row");
    expect(rows).toHaveLength(3);
    const buttons = rows.map((row) => row.querySelector("button"));
    expect(buttons[0]).toHaveAttribute("data-lineage", "root");
    expect(buttons[0]).toHaveAttribute("data-depth", "0");
    expect(buttons[1]).toHaveAttribute("data-lineage", "continuation");
    expect(buttons[1]).toHaveAttribute("data-depth", "1");
    expect(buttons[2]).toHaveAttribute("data-lineage", "continuation");
    expect(buttons[2]).toHaveAttribute("data-depth", "2");

    const user = setupUser();
    await user.click(screen.getAllByText(/chain-2/)[0]);
    await user.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByTestId("diff-lineage-label")).toHaveTextContent(
      "Continuation of chain-",
    );
    expect(screen.getByText("turn 2 user")).toBeInTheDocument();
    expect(screen.queryByText("turn 1 user")).toBeNull();
  });

  it("renders the launch marker only for clients with a launchId", () => {
    const state = useProxyStore.getState();
    state.upsertClient(client("untagged", "Untagged client"));
    const tagged: ClientInfo = {
      ...client("launch-XYZ", "Tagged client"),
      launchId: "XYZ" as ClientInfo["launchId"],
    };
    state.upsertClient(tagged);

    renderLive();

    const markers = screen.queryAllByTestId("live-launch-marker");
    // One marker, attached to the tagged client's tab.
    expect(markers).toHaveLength(1);
    const taggedButton = screen.getByRole("button", { name: /Tagged client/ });
    expect(within(taggedButton).getByTestId("live-launch-marker")).toBeTruthy();
    // The untagged client renders without a marker.
    const untaggedButton = screen.getByRole("button", {
      name: /Untagged client/,
    });
    expect(
      within(untaggedButton).queryByTestId("live-launch-marker"),
    ).toBeNull();
  });

  it("Prompts toggle reveals system-prompt buckets and clicking a bucket filters the list", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    // Three requests across two distinct system prompts → two buckets.
    for (const event of [
      ...promptEvents("req-1", "client-a", "System Prompt Alpha", 10),
      ...promptEvents("req-2", "client-a", "System Prompt Alpha", 20),
      ...promptEvents("req-3", "client-a", "System Prompt Beta", 30),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    // Panel is hidden by default.
    expect(screen.queryByTestId("prompts-panel")).toBeNull();

    // Click the toggle.
    await user.click(screen.getByTestId("prompts-toggle"));

    // Panel renders both buckets, most recent first (Beta started at 30).
    const panel = screen.getByTestId("prompts-panel");
    const cards = within(panel).getAllByTestId("prompt-bucket-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("System Prompt Beta");
    expect(cards[1].textContent).toContain("System Prompt Alpha");
    // Alpha covers 2 requests; Beta covers 1.
    expect(cards[1].textContent).toMatch(/used by 2 requests/);
    expect(cards[0].textContent).toMatch(/used by 1 request/);

    // Three rows visible before any filter.
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(3);

    // Filter to Alpha (the second card).
    await user.click(within(cards[1]).getByTestId("prompt-bucket-filter"));

    // Only the two Alpha rows remain visible.
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(2);
    // Filter indicator appears on the toggle.
    expect(screen.getByTestId("prompts-filter-dot")).toBeTruthy();

    // Click again to clear.
    const alphaCardAfter = within(
      screen.getByTestId("prompts-panel"),
    ).getAllByTestId("prompt-bucket-card")[1];
    await user.click(
      within(alphaCardAfter).getByTestId("prompt-bucket-filter"),
    );

    expect(screen.getAllByTestId("live-request-row")).toHaveLength(3);
    expect(screen.queryByTestId("prompts-filter-dot")).toBeNull();
  });

  it("filter chips compose: [Errors: yes] narrows the list to errored records, Clear restores it", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    // One successful and one errored request — chips should distinguish them.
    for (const event of [
      ...events("req-a", "client-a"),
      ...erroredEvents("req-bad", "client-a"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    // Both rows visible with no filter applied.
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(2);

    // Open Errors chip and click "yes".
    await user.click(screen.getByTestId("filter-chip-errors"));
    await user.click(screen.getByTestId(optId("errors", "yes")));

    // Only the errored row remains.
    const rowsAfter = screen.getAllByTestId("live-request-row");
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].textContent).toContain("req-ba");

    // Chip reflects the active state in its label and data-active flag.
    const chip = screen.getByTestId("filter-chip-errors");
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(chip.textContent).toContain("yes");

    // Clear restores everything.
    await user.click(screen.getByTestId("filter-chips-clear"));
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(2);
    expect(screen.getByTestId("filter-chip-errors").getAttribute("data-active"))
      .toBe("false");
  });

  it("filter chips and the existing prompt-hash filter AND together via visibleRequests", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    // Two distinct prompts × {success, error} so the cross-filter
    // intersection is unambiguous.
    for (const event of [
      ...promptEvents("req-alpha-ok", "client-a", "Alpha", 10),
      ...promptEvents("req-beta-ok", "client-a", "Beta", 20),
      ...erroredPromptEvents("req-alpha-bad", "client-a", "Alpha", 30),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(3);

    // Filter to the Alpha prompt → 2 rows (alpha-ok + alpha-bad).
    await user.click(screen.getByTestId("prompts-toggle"));
    // Bucket order is most-recent-first and depends on test data, so
    // pick the bucket card by its visible content rather than index.
    const alphaCard = within(screen.getByTestId("prompts-panel"))
      .getAllByTestId("prompt-bucket-card")
      .find((card) => card.textContent?.includes("Alpha"));
    if (alphaCard === undefined) throw new Error("Alpha bucket card missing");
    await user.click(within(alphaCard).getByTestId("prompt-bucket-filter"));
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(2);

    // AND-compose with Errors=yes → just alpha-bad.
    await user.click(screen.getByTestId("filter-chip-errors"));
    await user.click(screen.getByTestId(optId("errors", "yes")));
    const remaining = screen.getAllByTestId("live-request-row");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain("req-alpha-bad");
  });

  it("clicking the hash badge expands the bucket to show the full prompt", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    // A prompt longer than the 480-char collapsed preview cap.
    const longPrompt = "PROMPT_HEAD " + "x".repeat(700) + " PROMPT_TAIL";
    for (const event of [
      ...promptEvents("req-1", "client-a", longPrompt, 10),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();
    await user.click(screen.getByTestId("prompts-toggle"));

    const card = screen.getByTestId("prompt-bucket-card");
    const preview = within(card).getByTestId("prompt-bucket-preview");

    // Collapsed: head visible, tail hidden (truncated past 480 chars).
    expect(preview.textContent).toContain("PROMPT_HEAD");
    expect(preview.textContent).not.toContain("PROMPT_TAIL");
    expect(card.getAttribute("data-expanded")).toBe("false");

    // Click the hash badge to expand.
    await user.click(within(card).getByTestId("prompt-bucket-hash"));

    expect(card.getAttribute("data-expanded")).toBe("true");
    const expandedPreview = within(card).getByTestId("prompt-bucket-preview");
    expect(expandedPreview.textContent).toContain("PROMPT_HEAD");
    expect(expandedPreview.textContent).toContain("PROMPT_TAIL");

    // Click again to collapse.
    await user.click(within(card).getByTestId("prompt-bucket-hash"));
    expect(card.getAttribute("data-expanded")).toBe("false");
    expect(
      within(card).getByTestId("prompt-bucket-preview").textContent,
    ).not.toContain("PROMPT_TAIL");
  });

  it("typing in the search input narrows the request list to matches and Cmd+F focuses it", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    for (const event of [
      ...searchableEvents("req-needle", "client-a", "find the needle inline"),
      ...searchableEvents("req-other", "client-a", "totally different content"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    expect(screen.getAllByTestId("live-request-row")).toHaveLength(2);

    // Cmd+F focuses the search input.
    await user.keyboard("{Meta>}f{/Meta}");
    expect(screen.getByTestId("search-input")).toBe(document.activeElement);

    // Typing narrows to the matching row.
    await user.type(screen.getByTestId("search-input"), "needle");
    const remaining = screen.getAllByTestId("live-request-row");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain("req-needle");

    // Clearing restores both rows.
    await user.clear(screen.getByTestId("search-input"));
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(2);
  });

  it("global scope overrides the client filter so matches in other clients become visible", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    state.upsertClient(client("client-b", "Codex @ app"));
    for (const event of [
      ...searchableEvents("req-a-noise", "client-a", "uninteresting content"),
      ...searchableEvents("req-b-target", "client-b", "the special needle"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    // Scope to client-a — client-b's match is filtered out.
    await user.click(screen.getByText("Claude @ app"));
    await user.type(screen.getByTestId("search-input"), "needle");
    expect(screen.queryAllByTestId("live-request-row")).toHaveLength(0);

    // Toggle to global — the match in client-b appears even though
    // the client tab is still on client-a.
    await user.click(screen.getByTestId("search-scope-toggle"));
    const rows = screen.getAllByTestId("live-request-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("req-b-target");
  });

  it("live update mid-stream: appending an SSE event with matching content surfaces a previously-unmatched record", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    for (const event of [
      ...searchableEvents("req-existing", "client-a", "nothing to see"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();

    await user.type(screen.getByTestId("search-input"), "mid-stream");
    expect(screen.queryAllByTestId("live-request-row")).toHaveLength(0);

    // Simulate a new request arriving live whose content matches the
    // active query. findAllByTestId awaits the next React flush so
    // the assertion verifies the within-one-render-cycle promise of
    // design §8.5 rather than racing the Zustand-triggered update.
    for (const event of searchableEvents(
      "req-live",
      "client-a",
      "fresh data carrying the mid-stream needle",
    )) {
      useProxyStore.getState().appendEvent(event);
    }

    const rows = await screen.findAllByTestId("live-request-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("req-live");
  });

  it("Clear resets the search query alongside other filters", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    for (const event of [
      ...searchableEvents("req-one", "client-a", "first message"),
      ...searchableEvents("req-two", "client-a", "second message"),
    ]) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();
    await user.type(screen.getByTestId("search-input"), "first");
    expect(screen.getAllByTestId("live-request-row")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    // Store is fully reset by Clear — both records are gone and the
    // input reads back as empty.
    expect(screen.queryAllByTestId("live-request-row")).toHaveLength(0);
    expect(
      (screen.getByTestId("search-input") as HTMLInputElement).value,
    ).toBe("");
  });

  it("matching text inside the Response tab is wrapped in <mark>", async () => {
    const user = setupUser();
    const state = useProxyStore.getState();
    state.upsertClient(client("client-a", "Claude @ app"));
    for (const event of searchableEvents(
      "req-marked",
      "client-a",
      "irrelevant body",
      "the response says distinctive_marker_token loudly",
    )) {
      useProxyStore.getState().appendEvent(event);
    }

    renderLive();
    await user.type(
      screen.getByTestId("search-input"),
      "distinctive_marker_token",
    );

    // Select the matching row.
    await user.click(screen.getByText(/req-marked/));
    await user.click(screen.getByRole("button", { name: "Response" }));

    const marks = screen.getAllByTestId("search-highlight");
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks[0].textContent).toBe("distinctive_marker_token");
  });
});

// Builds the minimum 3-event sequence (headers → body → response_complete)
// the store needs to render a request row with searchable content in both
// the request body and the assembled response.
function searchableEvents(
  requestId: string,
  clientId: string,
  userText: string,
  assistantText = "default assistant reply",
): ProxyEvent[] {
  return [
    {
      requestId,
      clientId,
      globalSeq: 1,
      recvNs: 1,
      kind: "request_headers",
      method: "POST",
      url: `https://api.example.test/${requestId}`,
      headers: {},
    },
    {
      requestId,
      clientId,
      globalSeq: 2,
      recvNs: 2,
      kind: "request_body",
      body: {
        model: "claude-test",
        system: "test system",
        messages: [{ role: "user", content: userText }],
      },
    },
    {
      requestId,
      clientId,
      globalSeq: 3,
      recvNs: 3,
      kind: "response_complete",
      body: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: assistantText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}

function chainEvents(): ProxyEvent[] {
  const events: ProxyEvent[] = [];
  const messages: unknown[] = [];
  let seq = 1;
  const t = (n: number): number => n;
  for (let i = 1; i <= 3; i++) {
    const requestId = `chain-${i}`;
    if (i === 1) {
      messages.push({ role: "user", content: "turn 1 user" });
    } else {
      messages.push({ role: "assistant", content: `turn ${i - 1} assistant` });
      messages.push({ role: "user", content: `turn ${i} user` });
    }
    events.push({
      requestId,
      clientId: "client-a",
      globalSeq: seq++,
      recvNs: t(i * 10),
      kind: "request_headers",
      method: "POST",
      url: `https://api.example.test/${requestId}`,
      headers: {},
    });
    events.push({
      requestId,
      clientId: "client-a",
      globalSeq: seq++,
      recvNs: t(i * 10 + 1),
      kind: "request_body",
      body: { model: "claude-test", messages: [...messages] },
    });
    events.push({
      requestId,
      clientId: "client-a",
      globalSeq: seq++,
      recvNs: t(i * 10 + 2),
      kind: "response_complete",
      body: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    });
  }
  return events;
}

function promptEvents(
  requestId: string,
  clientId: string,
  systemPrompt: string,
  recvNs: number,
): ProxyEvent[] {
  return [
    {
      requestId,
      clientId,
      globalSeq: recvNs,
      recvNs,
      kind: "request_headers",
      method: "POST",
      url: `https://api.example.test/${requestId}`,
      headers: {},
    },
    {
      requestId,
      clientId,
      globalSeq: recvNs + 1,
      recvNs: recvNs + 1,
      kind: "request_body",
      body: {
        model: "claude-test",
        system: systemPrompt,
        messages: [{ role: "user", content: `hello ${requestId}` }],
      },
    },
  ];
}

function erroredEvents(requestId: string, clientId: string): ProxyEvent[] {
  return [
    {
      requestId,
      clientId,
      globalSeq: 100,
      recvNs: 100,
      kind: "request_headers",
      method: "POST",
      url: `https://api.example.test/${requestId}`,
      headers: {},
    },
    {
      requestId,
      clientId,
      globalSeq: 101,
      recvNs: 101,
      kind: "request_body",
      body: {
        model: "claude-test",
        system: "Test system",
        messages: [{ role: "user", content: `hello ${requestId}` }],
      },
    },
    {
      requestId,
      clientId,
      globalSeq: 102,
      recvNs: 102,
      kind: "proxy_error",
      error: "synthetic test failure",
    },
  ];
}

function erroredPromptEvents(
  requestId: string,
  clientId: string,
  systemPrompt: string,
  recvNs: number,
): ProxyEvent[] {
  return [
    ...promptEvents(requestId, clientId, systemPrompt, recvNs),
    {
      requestId,
      clientId,
      globalSeq: recvNs + 2,
      recvNs: recvNs + 2,
      kind: "proxy_error",
      error: "synthetic test failure",
    },
  ];
}

function client(clientId: string, displayName: string): ClientInfo {
  return {
    clientId,
    pid: null,
    rootPid: null,
    displayName,
    command: null,
    cwd: null,
    lastSeenNs: 1,
    launchId: null,
  };
}

function events(requestId: string, clientId: string): ProxyEvent[] {
  return [
    {
      requestId,
      clientId,
      globalSeq: requestId === "req-a" ? 1 : 3,
      recvNs: 1,
      kind: "request_headers",
      method: "POST",
      url: `https://api.example.test/${requestId}`,
      headers: {},
    },
    {
      requestId,
      clientId,
      globalSeq: requestId === "req-a" ? 2 : 4,
      recvNs: 2,
      kind: "request_body",
      body: {
        model: "claude-test",
        system: "Test system",
        messages: [{ role: "user", content: `hello ${requestId}` }],
      },
    },
    {
      requestId,
      clientId,
      globalSeq: requestId === "req-a" ? 3 : 5,
      recvNs: 3,
      kind: "response_complete",
      body: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage:
          requestId === "req-a"
            ? {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_input_tokens: 7,
                cache_creation_input_tokens: 5,
              }
            : { input_tokens: 20, output_tokens: 5 },
      },
    },
  ];
}
