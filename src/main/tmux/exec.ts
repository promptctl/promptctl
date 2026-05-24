// [LAW:single-enforcer] Every non-control-mode tmux shellout in main goes
// through this one function. The flat-mesh connection uses it for two
// bootstrap-style operations that cannot route through a TmuxClient:
//   - `list-sessions` to enumerate session ids before any client is spawned
//     (a chicken-and-egg avoided by shelling out to tmux directly)
//   - `kill-session` on close() to tear down sessions promptctl created
// Runtime tmux operations (send-keys, capture-pane, subscribe, etc.) route
// through the control connection / library clients instead.
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

export function tmuxExec(args: string[], timeoutMs = 5000): Promise<string> {
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
