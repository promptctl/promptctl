import { describe, it, expect } from "vitest";
import { redactSample, isSecretField } from "../core/redact";

describe("redactSample", () => {
  it("passes through booleans, numbers, null", () => {
    expect(redactSample(true)).toBe("true");
    expect(redactSample(42)).toBe("42");
    expect(redactSample(null)).toBe("null");
  });

  it("normalizes UUIDs and timestamps", () => {
    expect(redactSample("550e8400-e29b-41d4-a716-446655440000")).toBe("<UUID>");
    expect(redactSample("2026-04-20T03:10:00.000Z")).toBe("<TIMESTAMP>");
  });

  it("replaces paths, emails, urls inline in short strings", () => {
    expect(redactSample("error at /Users/bob/app/main.ts:42")).toBe(
      "error at <PATH>",
    );
    expect(redactSample("contact alice@example.com for details")).toBe(
      "contact <EMAIL> for details",
    );
    expect(redactSample("GET https://api.example.com/v1")).toBe("GET <URL>");
  });

  it("redacts long strings to a descriptor", () => {
    const long = "x".repeat(500);
    expect(redactSample(long)).toBe("<text: ~500 chars>");
  });

  it("replaces content of secret-named fields unconditionally", () => {
    expect(redactSample("anything", { fieldName: "apiKey" })).toBe("<SECRET>");
    expect(redactSample("anything", { fieldName: "AUTHORIZATION" })).toBe(
      "<SECRET>",
    );
    expect(redactSample(42, { fieldName: "token" })).toBe("42"); // numbers pass
  });

  it("replaces Anthropic-style secret tokens in strings", () => {
    expect(redactSample("sk-abc123def456ghi789jkl012")).toBe("<SECRET>");
  });

  it("summarizes arrays and objects without leaking content", () => {
    expect(redactSample([1, 2, 3])).toBe("<array: 3 items>");
    expect(redactSample({ foo: "bar", baz: 1 })).toBe(
      "<object: keys=[baz,foo]>",
    );
  });

  it("redacts dynamic object keys like file paths", () => {
    const obj = { "/Users/alice/x.ts": 1, "/Users/alice/y.ts": 2 };
    expect(redactSample(obj)).toBe("<object: keys=[<dyn>,<dyn>]>");
  });

  it("is deterministic — same input → same output", () => {
    const v = "path is /Users/bob/x.ts and email is a@b.com";
    expect(redactSample(v)).toBe(redactSample(v));
  });
});

describe("isSecretField", () => {
  it("matches known secret names case-insensitively", () => {
    expect(isSecretField("apiKey")).toBe(true);
    expect(isSecretField("API_KEY")).toBe(true);
    expect(isSecretField("password")).toBe(true);
    expect(isSecretField("authorization")).toBe(true);
  });

  it("rejects non-secret names", () => {
    expect(isSecretField("type")).toBe(false);
    expect(isSecretField("content")).toBe(false);
    expect(isSecretField(undefined)).toBe(false);
  });
});
