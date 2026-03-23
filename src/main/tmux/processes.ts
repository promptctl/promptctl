import { execFile } from "node:child_process";
import type { ProcessInfo } from "../../shared/types";

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        // pgrep returns exit 1 when no processes found — that's not an error
        if (cmd === "pgrep" && error.code === 1) {
          resolve("");
          return;
        }
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function parsePsOutput(stdout: string): ProcessInfo[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // ps with = suppresses headers and uses fixed-width columns
      // Format: pid ppid comm etime cputime args...
      // We use a delimiter-based approach with -o and custom separator
      const fields = line.trim().split(/\s+/);
      return {
        pid: parseInt(fields[0] ?? "0", 10),
        ppid: parseInt(fields[1] ?? "0", 10),
        comm: fields[2] ?? "",
        elapsed: fields[3] ?? "",
        cpuTime: fields[4] ?? "",
        // args is everything after the 5th field (may contain spaces)
        args: fields.slice(5).join(" "),
      };
    })
    .filter((p) => !isNaN(p.pid) && p.pid > 0);
}

export async function getPaneProcesses(
  panePid: number,
): Promise<ProcessInfo[]> {
  // Find direct children of the pane's shell process
  const pgrepOut = await exec("pgrep", ["-P", String(panePid)]);
  if (!pgrepOut.trim()) return [];

  const childPids = pgrepOut
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Get process details
  const psOut = await exec("ps", [
    "-o",
    "pid=,ppid=,comm=,etime=,cputime=,args=",
    "-p",
    childPids.join(","),
  ]);

  return parsePsOutput(psOut);
}
