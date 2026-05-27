import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { JsonlLineView } from "./JsonlLineView";

afterEach(cleanup);

// Tests assert BEHAVIOR (what the renderer produces in the DOM), not the
// exact class names or internal component structure. [LAW:behavior-not-structure]

describe("JsonlLineView — composed field grid", () => {
  it("never emits raw JSON text for a full assistant line", () => {
    const raw = {
      type: "assistant",
      uuid: "abcd-1234-efgh-5678",
      timestamp: "2025-01-15T10:30:00Z",
      cwd: "/Users/bmf/code/promptctl",
      gitBranch: "main",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: "text", text: "hello world" }],
      },
    };
    const { container } = render(<JsonlLineView raw={raw} />);
    // No raw JSON punctuation patterns anywhere in the output.
    const text = container.textContent ?? "";
    expect(text).not.toContain('"type":');
    expect(text).not.toContain('"uuid":');
    // Field grid should render the key names and the rendered content text.
    expect(screen.getByText("type")).toBeDefined();
    expect(screen.getByText("uuid")).toBeDefined();
    expect(screen.getByText("hello world")).toBeDefined();
  });

  it("renders a content-block array with tool_use + tool_result", () => {
    const raw = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            id: "toolu_abc",
            input: { command: "ls", cwd: "/tmp" },
          },
        ],
      },
    };
    render(<JsonlLineView raw={raw} />);
    // Tool name should be visible. Tool name appears twice (pill + ToolName
    // atom inside the content block), so use getAllByText to avoid a
    // multiple-match failure.
    expect(screen.getAllByText("Bash").length).toBeGreaterThan(0);
    expect(screen.getByText("command")).toBeDefined();
  });

  it("handles null raw without crashing", () => {
    render(<JsonlLineView raw={null} />);
    expect(screen.getByText(/no content/i)).toBeDefined();
  });

  it("highlights paired XML tags inline", () => {
    const raw = {
      type: "user",
      message: {
        role: "user",
        content:
          "Please run <command-name>/review</command-name> on the changes.",
      },
    };
    const { container } = render(<JsonlLineView raw={raw} />);
    // The inner text remains in the DOM; the tag literals do not.
    expect(container.textContent ?? "").toContain("/review");
    expect(container.textContent ?? "").not.toContain("<command-name>");
    expect(container.textContent ?? "").not.toContain("</command-name>");
  });

  it("marks substring matches in primitive string values when a highlight query is set", () => {
    const raw = { command: "grep -r needle src/" };
    const { getAllByTestId } = render(
      <JsonlLineView raw={raw} highlightSubstring="needle" />,
    );
    const marks = getAllByTestId("search-highlight");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]).toHaveTextContent("needle");
  });

  it("does not produce marks when no highlight query is set", () => {
    const raw = { command: "grep -r needle src/" };
    const { queryAllByTestId } = render(<JsonlLineView raw={raw} />);
    expect(queryAllByTestId("search-highlight")).toHaveLength(0);
  });

  it("marks substring matches in tool_use input field values", () => {
    const raw = {
      type: "tool_use",
      name: "Bash",
      id: "toolu_xyz",
      input: { command: "grep -r needle src/", file_path: "src/needle.ts" },
    };
    const { getAllByTestId } = render(
      <JsonlLineView raw={raw} highlightSubstring="needle" />,
    );
    const marks = getAllByTestId("search-highlight");
    // Expect a mark in the command value AND in the file_path field value.
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks.every((m) => m.textContent === "needle")).toBe(true);
  });
});
