import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  HighlightedText,
  HighlightQueryProvider,
  splitHighlights,
  useHighlightQuery,
} from "./highlight";

afterEach(cleanup);

describe("splitHighlights", () => {
  it("empty query yields a single non-match segment", () => {
    const segments = splitHighlights("the quick brown fox", "");
    expect(segments).toEqual([{ text: "the quick brown fox", isMatch: false }]);
  });

  it("empty text yields a single non-match segment", () => {
    expect(splitHighlights("", "needle")).toEqual([
      { text: "", isMatch: false },
    ]);
  });

  it("highlights a single match preserving original case", () => {
    const segments = splitHighlights("Hello, World", "world");
    expect(segments).toEqual([
      { text: "Hello, ", isMatch: false },
      { text: "World", isMatch: true },
    ]);
  });

  it("highlights multiple non-overlapping matches", () => {
    const segments = splitHighlights("aXbXc", "x");
    expect(segments).toEqual([
      { text: "a", isMatch: false },
      { text: "X", isMatch: true },
      { text: "b", isMatch: false },
      { text: "X", isMatch: true },
      { text: "c", isMatch: false },
    ]);
  });

  it("handles a match at the start", () => {
    const segments = splitHighlights("foo bar", "foo");
    expect(segments).toEqual([
      { text: "foo", isMatch: true },
      { text: " bar", isMatch: false },
    ]);
  });

  it("handles a match at the end", () => {
    const segments = splitHighlights("foo bar", "bar");
    expect(segments).toEqual([
      { text: "foo ", isMatch: false },
      { text: "bar", isMatch: true },
    ]);
  });

  it("does not infinite-loop on adjacent matches", () => {
    const segments = splitHighlights("aaaa", "aa");
    expect(segments).toEqual([
      { text: "aa", isMatch: true },
      { text: "aa", isMatch: true },
    ]);
  });
});

describe("HighlightedText", () => {
  it("renders the original text when query is empty", () => {
    render(<HighlightedText text="Hello, World" query="" />);
    expect(screen.queryByTestId("search-highlight")).toBeNull();
    expect(screen.getByText("Hello, World")).toBeInTheDocument();
  });

  it("wraps matches in a <mark> element with the canonical testid", () => {
    render(<HighlightedText text="Hello, World" query="world" />);
    const mark = screen.getByTestId("search-highlight");
    expect(mark.tagName.toLowerCase()).toBe("mark");
    expect(mark).toHaveTextContent("World");
  });
});

describe("HighlightQueryContext", () => {
  function QueryProbe() {
    const query = useHighlightQuery();
    return <span data-testid="probe">{query === "" ? "(none)" : query}</span>;
  }

  it("defaults to empty when no Provider is mounted", () => {
    render(<QueryProbe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("(none)");
  });

  it("delivers the Provider's query to descendants", () => {
    render(
      <HighlightQueryProvider query="needle">
        <QueryProbe />
      </HighlightQueryProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("needle");
  });
});
