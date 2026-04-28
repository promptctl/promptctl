import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { blockKey, renderBlock } from "./blocks";

afterEach(() => {
  cleanup();
});

describe("renderBlock registry", () => {
  it("renders text blocks via TextBlock", () => {
    render(<>{renderBlock({ type: "text", text: "hello" }, { index: 0 })}</>);
    const node = screen.getByTestId("block-text");
    expect(node).toHaveTextContent("text");
    expect(node).toHaveTextContent("hello");
  });

  it("renders tool_use blocks with name and id prefix", () => {
    render(
      <>
        {renderBlock(
          {
            type: "tool_use",
            id: "toolu_01abcdef9999",
            name: "Bash",
            input: { command: "ls" },
          },
          { index: 0 },
        )}
      </>,
    );
    const node = screen.getByTestId("block-tool-use");
    expect(node).toHaveTextContent("tool_use");
    expect(node).toHaveTextContent("Bash");
    expect(node).toHaveTextContent("toolu_01");
  });

  it("renders tool_result blocks and links to the originating tool_use", () => {
    render(
      <>
        {renderBlock(
          {
            type: "tool_result",
            tool_use_id: "toolu_zzzz1234",
            content: "ok",
          },
          { index: 0 },
        )}
      </>,
    );
    const node = screen.getByTestId("block-tool-result");
    expect(node).toHaveTextContent("tool_result");
    expect(node).toHaveTextContent("toolu_zz");
    expect(node).toHaveTextContent("ok");
  });

  it("flags is_error tool_results with error styling", () => {
    render(
      <>
        {renderBlock(
          {
            type: "tool_result",
            tool_use_id: "toolu_x",
            content: "boom",
            is_error: true,
          },
          { index: 0 },
        )}
      </>,
    );
    const node = screen.getByTestId("block-tool-result");
    expect(node).toHaveTextContent("error");
    expect(node.className).toMatch(/border-red/);
  });

  it("renders thinking blocks collapsed with char count", () => {
    render(
      <>
        {renderBlock(
          { type: "thinking", thinking: "abcde" },
          { index: 0 },
        )}
      </>,
    );
    const node = screen.getByTestId("block-thinking");
    expect(node).toHaveTextContent("thinking · 5 chars");
  });

  it("falls through to OpaqueBlock for unknown types", () => {
    render(
      <>
        {renderBlock({ type: "redacted_thinking", data: "xx" }, { index: 7 })}
      </>,
    );
    const node = screen.getByTestId("block-opaque");
    expect(node).toHaveTextContent("redacted_thinking #7");
  });

  it("falls through to OpaqueBlock for non-object input", () => {
    render(<>{renderBlock(null, { index: 3 })}</>);
    expect(screen.getByTestId("block-opaque")).toHaveTextContent("unknown #3");
  });
});

describe("blockKey", () => {
  it("uses block.id when present", () => {
    expect(blockKey({ type: "tool_use", id: "abc", name: "x" }, 0)).toBe("abc");
  });

  it("uses tool_use_id for tool_result blocks", () => {
    expect(
      blockKey({ type: "tool_result", tool_use_id: "tu1" }, 4),
    ).toBe("tool_result-tu1");
  });

  it("falls back to type+index", () => {
    expect(blockKey({ type: "text", text: "hi" }, 2)).toBe("block-text-2");
  });
});
