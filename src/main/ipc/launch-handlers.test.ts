// [LAW:locality-or-seam] Unit test for the terminate idempotency
// predicate. The race the handler closes — tmux replies "can't find
// session" because the tool exited before the registry observed the
// pane/window-close — is meaningful enough to pin at the predicate
// level even though the full handler is exercised by the integration
// suite.
import { describe, expect, it } from "vitest";
import { isSessionGone } from "./launch-handlers";

describe("isSessionGone", () => {
  it("returns false for non-Error inputs", () => {
    expect(isSessionGone(null)).toBe(false);
    expect(isSessionGone(undefined)).toBe(false);
    expect(isSessionGone("can't find session")).toBe(false);
    expect(isSessionGone({ message: "can't find session" })).toBe(false);
  });

  it("matches tmux's reply via Error.message", () => {
    expect(isSessionGone(new Error("can't find session: $42"))).toBe(true);
    expect(isSessionGone(new Error("server died"))).toBe(false);
  });

  it("matches via the library's TmuxCommandError shape (.response.output)", () => {
    // The library throws an Error subclass with a `response.output`
    // string array. The reply text from tmux lands in there; the
    // top-level `message` is a generic wrapper. We must look inside
    // `response.output`, not at `message` alone.
    const err = Object.assign(new Error("tmux command failed"), {
      response: { output: ["can't find session: $42", ""] },
    });
    expect(isSessionGone(err)).toBe(true);
  });

  it("does not match unrelated tmux errors carrying a response", () => {
    const err = Object.assign(new Error("tmux command failed"), {
      response: { output: ["server exited", ""] },
    });
    expect(isSessionGone(err)).toBe(false);
  });
});
