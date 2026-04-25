// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  assertDevWrapperEnv,
  DEV_WRAPPER_ENV_VAR,
  DEV_WRAPPER_SENTINEL,
} from "../dev/wrapper-guard";

describe("assertDevWrapperEnv", () => {
  it("passes when the sentinel is set", () => {
    expect(() =>
      assertDevWrapperEnv({ [DEV_WRAPPER_ENV_VAR]: DEV_WRAPPER_SENTINEL }),
    ).not.toThrow();
  });

  it("throws with a remediation message when the sentinel is missing", () => {
    expect(() => assertDevWrapperEnv({})).toThrow(/npm start/);
    expect(() => assertDevWrapperEnv({})).toThrow(/scripts\/dev\.ts/);
  });

  it("throws when the sentinel value is wrong", () => {
    expect(() => assertDevWrapperEnv({ [DEV_WRAPPER_ENV_VAR]: "true" })).toThrow();
    expect(() => assertDevWrapperEnv({ [DEV_WRAPPER_ENV_VAR]: "" })).toThrow();
  });

  it("error names the env var so users can bypass intentionally", () => {
    expect(() => assertDevWrapperEnv({})).toThrow(
      new RegExp(`${DEV_WRAPPER_ENV_VAR}=${DEV_WRAPPER_SENTINEL}`),
    );
  });
});
