import { cleanup, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { UsageBadges } from "./UsageBadges";

beforeEach(() => {
  cleanup();
});

describe("UsageBadges", () => {
  it("renders all usage fields with their color classes", () => {
    render(
      <UsageBadges
        usage={{
          input_tokens: 1234,
          output_tokens: 56,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 80,
        }}
        size="full"
      />,
    );

    expect(screen.getByTestId("usage-pill-input")).toHaveTextContent("in1.2k");
    expect(screen.getByTestId("usage-pill-cache-creation")).toHaveTextContent(
      "cache+10",
    );
    expect(screen.getByTestId("usage-pill-cache-read")).toHaveTextContent(
      "cache·80",
    );
    expect(screen.getByTestId("usage-pill-output")).toHaveTextContent("out56");
    expect(screen.getByTestId("usage-pill-cache-creation")).toHaveClass(
      "text-amber-400",
    );
    expect(screen.getByTestId("usage-pill-cache-read")).toHaveClass(
      "text-green-400",
    );
  });

  it("renders missing optional fields as placeholders", () => {
    render(
      <UsageBadges
        usage={{
          input_tokens: 10,
          output_tokens: 20,
        }}
      />,
    );

    expect(screen.getByTestId("usage-pill-input")).toHaveTextContent("in10");
    expect(screen.getByTestId("usage-pill-cache-creation")).toHaveTextContent(
      "cache+…",
    );
    expect(screen.getByTestId("usage-pill-cache-read")).toHaveTextContent(
      "cache·…",
    );
    expect(screen.getByTestId("usage-pill-output")).toHaveTextContent("out20");
  });

  it("renders null usage as stable placeholders", () => {
    render(<UsageBadges usage={null} />);

    const badges = screen.getByTestId("usage-badges");
    expect(within(badges).getByTestId("usage-pill-input")).toHaveTextContent(
      "in…",
    );
    expect(
      within(badges).getByTestId("usage-pill-cache-creation"),
    ).toHaveTextContent("cache+…");
    expect(
      within(badges).getByTestId("usage-pill-cache-read"),
    ).toHaveTextContent("cache·…");
    expect(within(badges).getByTestId("usage-pill-output")).toHaveTextContent(
      "out…",
    );
    expect(screen.getByTestId("usage-cache-bar")).toBeInTheDocument();
  });

  it("renders proportional cache bar segments", () => {
    render(
      <UsageBadges
        usage={{
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 80,
        }}
      />,
    );

    expect(screen.getByTestId("usage-segment-cache-read")).toHaveStyle({
      width: "80%",
    });
    expect(screen.getByTestId("usage-segment-cache-creation")).toHaveStyle({
      width: "10%",
    });
    expect(screen.getByTestId("usage-segment-input")).toHaveStyle({
      width: "10%",
    });
    expect(screen.getByTestId("usage-segment-cache-read")).toHaveAttribute(
      "data-share",
      "0.8",
    );
  });
});
