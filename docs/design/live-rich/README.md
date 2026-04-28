# Live tab — rich visualizations design

Lit ticket: `promptctl-live-tab-structured-views-ac1.6.1`
Parent epic: `promptctl-live-tab-structured-views-ac1` (Live tab structured views)
Status: in_progress

This document is the concrete design for the seven impl child tickets under `ac1.6`. Sections below have stable anchors; each impl ticket links to its anchor via a pinned comment.

---

## 0. Reframe

cc-dump is a TUI bound by terminal layout — single-column scrolling buffer, no fixed panes, no rich diffs, no virtualization. promptctl is an Electron app. We have:

- DOM with arbitrary layout (sticky panes, tabs, resizable splits — `ResizableSplit` already exists).
- A Zustand store that broadcasts diffs from the main process; the Live tab is already a projection.
- Stable request identity (`requestId`) emitted by the proxy and threaded through every event.
- Existing lineage that prefix-matches consecutive requests in a chain (`computeLineage` in `src/renderer/components/live-detail/lineage.ts`).

Designs in this doc exploit these and do not port cc-dump's compromises forward.

## 1. The cornerstone insight

Anthropic's Messages API resends the entire conversation on every request. In an N-turn chain, message #1 appears in N requests. The Request tab today renders message #1 N times and renders the same `tool_use` block N times whenever Claude Code re-sends it. This is unreadable past 3 turns.

The deduped conversation view is the central UX move. Once the Live tab projects a chain into a single timeline of *unique* messages, several of the proposed sub-features collapse from independent panels into annotations on that timeline:

- `tool_use` and its paired `tool_result` are adjacent timeline blocks (the result is a `user` message that appears in the next request).
- Stop-reason becomes a labeled marker between turns in the timeline.
- "Prompt diff across chain" becomes a highlight on the first turn whose system/tools differ from the previous turn.
- Search highlights blocks within the timeline rather than within a per-request soup.

Latency, content-addressed prompts, filter chips, and search remain orthogonal — they're list-level or cross-chain concerns, not within-chain.

## 2. Shared data model

This section is normative for every impl ticket. All projections are **renderer-side, pure**, derived from `RequestRecord[]` plus the existing `computeLineage`. No new IPC channel. `RequestRecord` stays canonical (`[LAW:one-source-of-truth]`). Live and replay produce identical projections (`[LAW:dataflow-not-control-flow]`).

### 2.1 Message identity (dedup key) <a id="identity"></a>

Identity rules, in priority order:

1. If a message has a string `id` field, that's the identity. (Anthropic doesn't currently include ids on `user` messages, but `assistant` messages preserve their `message_start.id` in `assembledResponse`. We use it where present.)
2. Otherwise, identity is `sha1(stable_json(role, content))`. `stable_json` sorts object keys recursively so semantically-identical messages hash equally regardless of property order.
3. Identity is computed once per message reference encountered while walking a chain; memoize via `WeakMap<object, string>` keyed on the message object.

Why hash and not just prefix-match like `computeLineage` does today: prefix-match tells us *whether* one request continues another; identity tells us *which message in the previous request equals this message*. The deduped timeline needs the latter.

**Acceptance check (machine-verifiable):**
Given two requests where request B = request A's messages + 2 new messages, the identity function must produce identical hashes for the first N messages and distinct hashes for the new 2. Test: `messageIdentity.test.ts`.

### 2.2 Chain projection <a id="chain"></a>

Given a `RequestRecord`, walk `lineage.parentId` upward to the chain root. The chain is the ordered list `[root, …, selected]`.

The deduped timeline of the chain is built by:

1. Take messages from the root request, in order.
2. For each subsequent request in the chain, append messages whose identity is not already in the set.
3. After each request's contributions, append a synthetic `RequestBoundary` entry containing `{ requestId, stopReason, usage, ttfbNs, durationNs }`.
4. After each request's `assembledResponse`, append the response content blocks as their own timeline entries with `producedByRequestId = requestId`.

Result is a single ordered list of `TimelineEntry` items:

```ts
type TimelineEntry =
  | { kind: "message"; identity: string; role: string; content: ContentBlock[]; introducedByRequestId: string }
  | { kind: "assistant_response"; identity: string; content: AnthropicContentBlock[]; producedByRequestId: string }
  | { kind: "request_boundary"; requestId: string; stopReason: string | null; usage: AnthropicUsage | null; ttfbNs: number | null; durationNs: number | null };
```

`assistant_response` is split from `message` because the timeline shows the assistant turn *as it was generated* (with stop_reason marker right after it) rather than as it appears in the next request's `messages[]`. When the user selects a different request in the chain, the timeline doesn't rebuild — the same array is rendered with a "selection" highlight on the entries whose `introducedByRequestId === selected`.

**Acceptance check:** A chain of 3 requests, each adding 1 user + 1 assistant message, produces a timeline of `root.messages + 2*(user, assistant_response, boundary) + final boundary`. Test: `chainProjection.test.ts`.

### 2.3 Where this lives

A new file `src/renderer/components/live-detail/conversation.ts` owns identity, chain projection, and the `TimelineEntry` type. The store does not cache projections — they're memoized per-render via `useMemo` on the chain's `requestId` list. Memoization key is the joined request ids, not the records themselves, because incoming SSE events mutate event arrays but not the chain shape until completion.

Caveat: streaming requests' assistant content updates as deltas arrive. The chain projection treats an in-flight request's `assembledResponse` as null and renders a placeholder `assistant_response` entry instead. When `state` transitions to `complete`, the entry is replaced (via memo invalidation when `state` changes).

---

## 3. Section: Deduped conversation view + structured block renderers

Lit ticket: `ac1.6.2` <a id="conversation"></a>

### 3.1 Layout

Replace the current Request tab with a `ConversationTimeline` component. The Diff tab stays for now (covered by chain-diff section below); it remains useful as a "just the new bits" view.

```
┌───────────────────────────────────────────┐
│ Request detail header (existing)          │
│ [Overview][Conversation][Diff][Resp][SSE] │
├───────────────────────────────────────────┤
│  ┌─ root request abc123 ────────────────┐ │
│  │ user: "Refactor X..."          (R1)  │ │
│  │ assistant: text + tool_use 1   (R1)  │ │
│  │ ┌─ stop_reason: tool_use ─────────┐  │ │
│  │ tool_result for tool_use 1     (R2)  │ │
│  │ assistant: text + tool_use 2   (R2)  │ │
│  │ ...                                  │ │
│  └──────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

- One vertical timeline. Each entry is a card with role badge, content blocks, and a small request-attribution chip (`R1`, `R2`, …) on the right edge linking back to that request row.
- Selected request is highlighted: entries with `introducedByRequestId === selected` get a left border accent. The currently-selected request's `assistant_response` is auto-scrolled into view on selection change.
- `request_boundary` entries render as a thin horizontal strip with stop_reason label + usage badges + TTFB ms (overlay from sparkline ticket). Width 100%, height ~24px, sticky-on-scroll within the chain (so the user always knows which request boundary they're past).

### 3.2 Block renderer registry <a id="block-registry"></a>

A single dispatch site. New file `src/renderer/components/live-detail/blocks/index.ts`:

```ts
export type BlockRenderer = (block: AnthropicContentBlock, ctx: BlockCtx) => ReactNode;
const REGISTRY: Record<string, BlockRenderer> = {
  text: TextBlock,
  tool_use: ToolUseBlock,
  tool_result: ToolResultBlock,
  thinking: ThinkingBlock,
};
export function renderBlock(block: AnthropicContentBlock, ctx: BlockCtx): ReactNode {
  return (REGISTRY[block.type] ?? OpaqueBlock)(block, ctx);
}
```

`[LAW:single-enforcer]`: every callsite that needs to render a content block goes through `renderBlock`. `MessageView`, `OverviewTab`, `DiffTab` all migrate to it.
`[LAW:one-type-per-behavior]`: one renderer file per block type, no scattered switches.
`[LAW:dataflow-not-control-flow]`: unknown block types fall through to `OpaqueBlock` (a JsonlLineView), not skipped — control flow is identical for every block.

### 3.3 Tool block rendering <a id="tool-blocks"></a>

`ToolUseBlock`:

- Header row: tool name in monospace badge, the tool's `id` truncated to 8 chars with click-to-copy.
- Body: input rendered with the existing `JsonlLineView` (which handles syntax highlighting and folding for nested JSON).
- Footer: a "→ result" link that scrolls to the paired `tool_result` block in the timeline. Pairing is by tool_use id; the timeline projection precomputes a `Map<toolUseId, toolResultEntryIndex>` once.

`ToolResultBlock`:

- Header row: "tool_result for X" where X links upward to the matching tool_use.
- Body: result content rendered as text if string, or as block list if array. `is_error: true` triggers red styling.
- A "← input" link scrolls to the paired tool_use.

`ThinkingBlock`:

- Collapsed by default (thinking blocks can be very long).
- Header: "thinking · N chars · cost: 0 if re-sent" — flag the known token-counting bug from project memory in the tooltip so users aren't misled by the badge in `UsageBadges`.

### 3.4 Acceptance criteria

- `ConversationTimeline` renders identical output for live and replay (`[LAW:dataflow-not-control-flow]`). Test: load a HAR with a known chain, snapshot the timeline; assert the same snapshot when the same events are replayed live.
- Two consecutive requests with overlapping prefix produce one timeline (no duplicate user message). Test in `chainProjection.test.ts`.
- `tool_use` with paired `tool_result` renders adjacent in the timeline; clicking the paired-link scrolls. Test: `toolPairing.test.tsx`.
- Block registry: every block type tested in isolation; an unknown type falls through to `OpaqueBlock`.

---

## 4. Section: Stop-reason flow strip

Lit ticket: `ac1.6.3` <a id="stop-reason"></a>

Subsumed by the timeline projection. `request_boundary` entries already carry `stopReason`. This ticket's scope is the styling and interactions:

- Color-coded by stop_reason: `tool_use` → cyan, `end_turn` → neutral, `max_tokens` → amber, `stop_sequence` → violet, `null` (in-flight) → animated pulse.
- Click expands an inline panel showing the full `message_delta` envelope.
- Above the timeline (sticky), a horizontal mini-flow shows the sequence of stop_reasons across the entire chain as colored chips: `[tool_use] → [tool_use] → [end_turn]`. Clicking a chip scrolls to that boundary.

**Acceptance:**
- One snapshot per stop_reason kind.
- Chain test: 3-request chain renders 3 chips in the mini-flow with correct colors.

---

## 5. Section: Latency / throughput sparklines

Lit ticket: `ac1.6.4` <a id="latency"></a>

### 5.1 Per-request badges

In each `RequestRow` in the request list (existing component), append two badges next to `UsageBadges`:

- `TTFB: 142ms` — `firstByteNs - startedNs`.
- `Δ 3.2s` — `(completedNs ?? now) - startedNs`. While in-flight, ticks every 250ms via a single shared interval (one timer for the whole list, not per-row — `[LAW:single-enforcer]`).

### 5.2 Chain sparkline

A 100×24 SVG above the conversation timeline showing TTFB across the chain's requests. X-axis is request index; Y-axis is log(ms). Bars colored by stop_reason for double-duty.

### 5.3 Tokens/sec

For complete requests, derive `output_tokens / (completedNs - firstByteNs)`. Render in the boundary entry as `· 47 tok/s`. For in-flight, omit (no skipped render — the slot exists, just empty content).

**Acceptance:**
- Derivation unit tests cover: in-flight, complete, errored (no firstByte), missing usage.
- Sparkline renders for chains of length 1, 2, and 10 without layout shift.

---

## 6. Section: Content-addressed system-prompt view

Lit ticket: `ac1.6.5` <a id="system-prompt"></a>

### 6.1 Hash function

Shared with `ac1.6.8`. New file `src/renderer/components/live-detail/promptHash.ts`:

```ts
export function systemPromptHash(body: unknown): string;
export function toolsHash(body: unknown): string;
```

Both use `sha1(stable_json(...))` over the relevant request-body slice. `systemPromptHash` accepts both string-form and array-of-blocks-form `system`.

### 6.2 Placement

A new collapsible right-rail panel on the Live page (between the request list and the detail pane), or — preferred — a third tab on the ClientTabs row called **Prompts** that opens a full-width view above the request list when active. The full-width view is better because system-prompt entries are wide (multi-line text) and benefit from horizontal space.

When inactive, the Prompts panel doesn't render — no layout impact on the list.

### 6.3 UI

Each entry is a card:

```
┌─ #abc123 ─ used by 47 requests · 3 clients ──┐
│ "You are Claude Code, Anthropic's official…" │
│ tools: [Bash, Read, Write, Edit, …] +12      │
│ [Filter list to this prompt] [Show diff]     │
└──────────────────────────────────────────────┘
```

Clicking "Filter list to this prompt" sets a filter (interacts with `ac1.6.6`). "Show diff" only enables once at least 2 distinct prompts exist; opens a side-by-side diff with another selected hash.

### 6.4 Acceptance

- Hash determinism: same prompt input → same hash across runs. Property test.
- Clustering: 3 requests with 2 distinct prompts → 2 buckets. Test.
- Hash is stable across replay (`[LAW:dataflow-not-control-flow]`).

---

## 7. Section: Filter chips

Lit ticket: `ac1.6.6` <a id="filters"></a>

### 7.1 Placement

Below `ClientTabs`, above the request list. A single horizontal strip:

```
[Model: any▾] [Status: any▾] [Tool use: any▾] [Errors: any▾] [Size: any▾] [Clear]
```

Each chip is a dropdown. Multi-select within a dropdown (OR within a category); chips compose with AND across categories.

### 7.2 State

New slice in `useProxyStore`: `filters: { models: Set<string>; statuses: Set<string>; toolUse: "any"|"yes"|"no"; errors: "any"|"yes"|"no"; sizeBuckets: Set<"small"|"medium"|"large"> }`. `[LAW:single-enforcer]` — the filter predicate lives in one place and is consumed by `visibleRequests`.

Predicate registry (`[LAW:one-type-per-behavior]`): one filter function per category; the composer ANDs them.

### 7.3 Size buckets

- small: request body < 4 KB
- medium: 4 KB ≤ … < 64 KB
- large: ≥ 64 KB

Computed once per record by the projection.

### 7.4 Persistence

Filters reset on `clearEvents`. They do NOT persist across sessions — this is a within-session debugging tool.

### 7.5 Acceptance

- Predicate composition tests (all 32 combinations of category-empty vs non-empty, sampled).
- Integration: applying `[Errors: yes]` reduces list to records with `record.error !== null`.

---

## 8. Section: Search across capture

Lit ticket: `ac1.6.7` <a id="search"></a>

### 8.1 Index shape

Per RequestRecord, derive `searchText`: concatenation of url + `requestBody.system` text + every message text content + every assistant text content + tool_use/tool_result text. Lowercased once.

Index is a `Map<requestId, string>` rebuilt incrementally: when a record's `state` transitions to `complete`, recompute its entry. In-flight records get partial text from current events.

### 8.2 UI

Search input replaces the StatusBar's "X requests · Y events · Z entries" label when focused (or sits beside it on wider widths). Keyboard shortcut: `Cmd+F` / `Ctrl+F` while the Live tab is active focuses it.

Default scope: selected client. Toggle button `[Global]` switches to all clients.

### 8.3 Highlights

- Request list: matching rows get a yellow dot in the leftmost column. Non-matching rows dim to 50% opacity (still clickable, so the user can see structure).
- Within the conversation timeline of a selected matching request: matching block content is wrapped in `<mark>` and the first match is auto-scrolled into view.

### 8.4 Live updates

Search reactively updates as new events arrive. A useEffect on `useProxyStore` subscribes to record updates and patches the index. The search predicate runs against the index, not the records — `[LAW:one-source-of-truth]` (RequestRecord is canonical; index is a derivation that re-builds on change).

### 8.5 Acceptance

- Index determinism: same records → same index strings.
- Live test: append matching SSE event mid-stream; assert highlight appears within one render cycle.
- Cmd+F focus test.

---

## 9. Section: Prompt diff across chain

Lit ticket: `ac1.6.8` <a id="chain-diff"></a>

### 9.1 Scope

The current `DiffTab` shows new messages vs parent — useful but narrow. This ticket adds a chain-level diff for system + tools.

### 9.2 UI

A new tab on `RequestDetail` called **Chain**. Layout:

```
[ Versions of system prompt across chain ]
v1 (#abc123) — used by R1, R2
v2 (#def456) — used by R3
  diff vs v1: + "You may now call the search tool"

[ Versions of tools array across chain ]
v1 — R1
v2 — R2..R3
  diff vs v1: + new tool "search"
```

Each version is collapsible. Diffs are textual (system) or structural (tools array — reuse `JsonlLineView` set-difference rendering).

### 9.3 Implementation

Walk the chain, hash system+tools per request, group by hash. For each consecutive distinct version pair, compute a diff and render. Hashing reuses `promptHash.ts` from `ac1.6.5`.

### 9.4 Acceptance

- Synthetic chain with 3 requests (system changes once, tools change twice) → 2 system versions, 3 tools versions, correct diffs.
- Diff renderer is the same `[LAW:single-enforcer]` instance used by the per-request DiffTab.

---

## 10. Cross-cutting: testing strategy

- All projections (identity, chain, hashes, filters, search index) are pure functions, unit-tested in isolation.
- Component snapshots cover the canonical states: empty, in-flight, complete, errored.
- Integration tests in `Live.test.tsx` (already exists) extend to cover: a 3-request chain renders one timeline, filter chips compose, search highlights.
- `[LAW:dataflow-not-control-flow]`: every test that exercises a live path also exercises a replay path with the same fixture and asserts identical output.

## 11. Out of scope (every section)

- Persistence beyond the current HAR file.
- Edit-and-replay flows.
- Non-Anthropic provider rendering (different SSE shape, separate epic).
- Cross-capture analytics / trends.

## 12. Open questions to confirm before impl

- **Identity for assistant messages**: when the assistant message in `request.messages[i]` is a re-send of an earlier `assembledResponse`, do we collapse them in the timeline? Current proposal: yes, by hash — `assistant_response` and the next request's `messages[i].assistant` should hash equally if Claude Code re-sends verbatim. If it doesn't (e.g. tool_use input gets normalized), we'll see two entries; that's probably fine but worth verifying with a real capture.
- **Sparkline placement**: above the timeline (proposed) vs in the StatusBar. Above keeps it scoped to the selected chain; StatusBar would show the global capture. Probably want both eventually.
- **Search regex**: out of scope for `ac1.6.7` per ticket; if users ask for it, it's a small follow-up.
