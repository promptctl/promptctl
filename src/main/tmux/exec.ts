// [LAW:single-enforcer] Every tmux process spawn in main goes through this
// one function. After 77e.1.9, the only legitimate caller is the session
// bootstrap (`ensureSession` in src/main/tmux/session.ts) — runtime tmux
// operations route through the TmuxControlConnection / TmuxClient instead.
// The bootstrap genuinely needs a non-control-mode shellout: we have to
// probe for and create the named session BEFORE attach-session can attach
// the control client, so a TmuxClient does not yet exist.
import { execFile } from "node:child_process";

export class TmuxError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr}`);
    this.name = "TmuxError";
  }
}

export function tmuxExec(
  args: string[],
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : null;
        reject(new TmuxError(args, code, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}
