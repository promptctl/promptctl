import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { RequestRecord } from "../../../shared/proxy-events";
import { DiffTab } from "./DiffTab";

beforeEach(() => cleanup());

describe("DiffTab", () => {
  it("renders the full message list when the request is a turn root", () => {
    const record = req([{ role: "user", content: "hello root" }]);
    render(
      <DiffTab
        record={record}
        lineage={{
          parentId: null,
          rootId: record.requestId,
          depth: 0,
          newMessages: [{ role: "user", content: "hello root" }],
          expectedCacheTokens: null,
        }}
      />,
    );
    expect(screen.getByTestId("diff-lineage-label")).toHaveTextContent(
      "Turn root",
    );
    expect(screen.getByText("hello root")).toBeInTheDocument();
    expect(screen.getByTestId("diff-cache-chip")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("renders only new messages when continuing a parent", () => {
    const record = req([
      { role: "user", content: "old turn" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "follow-up" },
    ]);
    render(
      <DiffTab
        record={record}
        lineage={{
          parentId: "parent-aaaaaa",
          rootId: "parent-aaaaaa",
          depth: 1,
          newMessages: [
            { role: "assistant", content: "old reply" },
            { role: "user", content: "follow-up" },
          ],
          expectedCacheTokens: 100,
        }}
      />,
    );
    expect(screen.getByTestId("diff-lineage-label")).toHaveTextContent(
      "Continuation of parent",
    );
    expect(screen.getByText("follow-up")).toBeInTheDocument();
    expect(screen.queryByText("old turn")).toBeNull();
    expect(screen.getByText("+2 new")).toBeInTheDocument();
  });

  it("flags a cache miss when actual cache_read is far below the parent's tokens", () => {
    const record = {
      ...req([{ role: "user", content: "x" }]),
      assembledResponse: {
        id: "msg",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
        },
      },
    };
    render(
      <DiffTab
        record={record}
        lineage={{
          parentId: "parent-x",
          rootId: "parent-x",
          depth: 1,
          newMessages: [],
          expectedCacheTokens: 200,
        }}
      />,
    );
    const chip = screen.getByTestId("diff-cache-chip");
    expect(chip).not.toHaveAttribute("aria-hidden", "true");
    expect(chip).toHaveTextContent(/cache miss/);
    expect(chip).toHaveClass("text-amber-300");
  });

  it("celebrates a cache hit when actual cache_read meets expectations", () => {
    const record = {
      ...req([{ role: "user", content: "x" }]),
      assembledResponse: {
        id: "msg",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 180,
        },
      },
    };
    render(
      <DiffTab
        record={record}
        lineage={{
          parentId: "parent-x",
          rootId: "parent-x",
          depth: 1,
          newMessages: [],
          expectedCacheTokens: 200,
        }}
      />,
    );
    const chip = screen.getByTestId("diff-cache-chip");
    expect(chip).toHaveTextContent(/cache hit/);
    expect(chip).toHaveClass("text-green-300");
  });

  it("renders an empty state when continuation has no new messages", () => {
    const record = req([{ role: "user", content: "same" }]);
    render(
      <DiffTab
        record={record}
        lineage={{
          parentId: "parent-x",
          rootId: "parent-x",
          depth: 1,
          newMessages: [],
          expectedCacheTokens: null,
        }}
      />,
    );
    expect(
      screen.getByText("No new messages compared to the parent request."),
    ).toBeInTheDocument();
  });
});

function req(messages: unknown[]): RequestRecord {
  return {
    requestId: "req-x",
    clientId: "client-x",
    method: "POST",
    url: "https://api.example.test/v1/messages",
    status: 200,
    startedNs: 1,
    firstByteNs: 2,
    completedNs: 3,
    endedNs: 3,
    requestBody: { model: "claude-test", messages },
    assembledResponse: null,
    error: null,
    state: "complete",
    events: [],
  };
}
