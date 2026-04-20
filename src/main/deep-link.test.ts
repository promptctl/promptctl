import { describe, it, expect } from "vitest";
import {
  parsePromptctlUrl,
  promptctlUrlToHash,
  findPromptctlUrlInArgv,
} from "./deep-link";

describe("parsePromptctlUrl", () => {
  const cases: [string, string, ReturnType<typeof parsePromptctlUrl>][] = [
    [
      "valid claude session",
      "promptctl://open?provider=claude&sessionId=abc-123",
      { provider: "claude", sessionId: "abc-123" },
    ],
    [
      "valid gemini session",
      "promptctl://open?provider=gemini&sessionId=xyz",
      { provider: "gemini", sessionId: "xyz" },
    ],
    [
      "uuid sessionId",
      "promptctl://open?provider=claude&sessionId=d3698a7d-5a50-40bb-a219-71dabb9ce615",
      {
        provider: "claude",
        sessionId: "d3698a7d-5a50-40bb-a219-71dabb9ce615",
      },
    ],
    ["missing sessionId", "promptctl://open?provider=claude", null],
    ["missing provider", "promptctl://open?sessionId=abc", null],
    [
      "wrong host",
      "promptctl://elsewhere?provider=claude&sessionId=abc",
      null,
    ],
    ["wrong scheme", "http://open?provider=claude&sessionId=abc", null],
    ["garbage", "not-a-url", null],
    ["empty", "", null],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(parsePromptctlUrl(input)).toEqual(expected);
    });
  }
});

describe("promptctlUrlToHash", () => {
  it("produces workshop route hash", () => {
    expect(
      promptctlUrlToHash("promptctl://open?provider=claude&sessionId=abc"),
    ).toBe("#/workshop?provider=claude&sessionId=abc");
  });

  it("url-encodes special chars in sessionId", () => {
    const hash = promptctlUrlToHash(
      "promptctl://open?provider=claude&sessionId=a%2Fb",
    );
    expect(hash).toBe("#/workshop?provider=claude&sessionId=a%2Fb");
  });

  it("returns null for invalid input", () => {
    expect(promptctlUrlToHash("bogus")).toBeNull();
  });
});

describe("findPromptctlUrlInArgv", () => {
  it("finds the URL among other argv entries", () => {
    const argv = [
      "/path/to/electron",
      "/path/to/app",
      "promptctl://open?provider=claude&sessionId=abc",
      "--some-flag",
    ];
    expect(findPromptctlUrlInArgv(argv)).toBe(
      "promptctl://open?provider=claude&sessionId=abc",
    );
  });

  it("returns null when no promptctl url present", () => {
    expect(findPromptctlUrlInArgv(["a", "b", "c"])).toBeNull();
  });
});
