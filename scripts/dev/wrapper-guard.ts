// [LAW:single-enforcer] One place defines the rule "dev launches must go
// through scripts/dev.ts". forge.config.ts's preStart hook calls this; the
// wrapper sets the sentinel before spawning forge.

export const DEV_WRAPPER_ENV_VAR = "PROMPTCTL_DEV_WRAPPER";
export const DEV_WRAPPER_SENTINEL = "1";

export function assertDevWrapperEnv(env: NodeJS.ProcessEnv): void {
  if (env[DEV_WRAPPER_ENV_VAR] !== DEV_WRAPPER_SENTINEL) {
    throw new Error(
      "Refusing to start: launch dev with `npm start` (which runs scripts/dev.ts).\n" +
        "Direct `electron-forge start` skips the main-process hot-restart watcher,\n" +
        "leaving you editing main-process code with no automatic reload.\n" +
        `If you really need to bypass, set ${DEV_WRAPPER_ENV_VAR}=${DEV_WRAPPER_SENTINEL} explicitly.`,
    );
  }
}
