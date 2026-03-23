// [LAW:single-enforcer] All tmux process spawning goes through here.
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
