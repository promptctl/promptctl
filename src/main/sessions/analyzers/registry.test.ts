import { afterEach, describe, expect, it } from "vitest";
import {
  registerAnalyzer,
  getAnalyzer,
  getAnalyzersForProvider,
  getAnalyzerMetadata,
  _resetAnalyzersForTesting,
} from "./registry";
import type { Analyzer } from "./types";

const fakeClaudeAnalyzer: Analyzer = {
  id: "fake-claude",
  name: "Fake Claude",
  description: "fake claude analyzer",
  providerId: "claude",
  async run() {
    return { analyzerId: "fake-claude", recommendations: [] };
  },
};

const fakeGeminiAnalyzer: Analyzer = {
  id: "fake-gemini",
  name: "Fake Gemini",
  description: "fake gemini analyzer",
  providerId: "gemini",
  async run() {
    return { analyzerId: "fake-gemini", recommendations: [] };
  },
};

describe("analyzer registry", () => {
  afterEach(() => {
    _resetAnalyzersForTesting();
  });

  it("registers and retrieves an analyzer by id", () => {
    registerAnalyzer(fakeClaudeAnalyzer);
    expect(getAnalyzer("fake-claude").name).toBe("Fake Claude");
  });

  it("throws when an analyzer id is not registered", () => {
    expect(() => getAnalyzer("not-here")).toThrow(/No analyzer registered/);
  });

  it("filters by provider", () => {
    registerAnalyzer(fakeClaudeAnalyzer);
    registerAnalyzer(fakeGeminiAnalyzer);
    const claude = getAnalyzersForProvider("claude");
    const gemini = getAnalyzersForProvider("gemini");
    expect(claude.map((a) => a.id)).toEqual(["fake-claude"]);
    expect(gemini.map((a) => a.id)).toEqual(["fake-gemini"]);
  });

  it("getAnalyzerMetadata returns only id/name/description (no run function)", () => {
    registerAnalyzer(fakeClaudeAnalyzer);
    const meta = getAnalyzerMetadata("claude");
    expect(meta).toEqual([
      {
        id: "fake-claude",
        name: "Fake Claude",
        description: "fake claude analyzer",
      },
    ]);
  });
});
