import { execFile, type ExecFileException } from "node:child_process";
import type { ProcessInfo } from "../../shared/types";

// [LAW:one-source-of-truth] The exit-code policy for process-set queries lives
// here, named, exercised by both callers and asserted directly in tests.
// [LAW:one-type-per-behavior] pgrep (enumerate children) and ps (read details)
// are the same behavior — a process-set query — and the BSD/macOS convention is
// exit code 1 == "no matching processes" for both.
// [LAW:dataflow-not-control-flow] A child exiting between the enumerate and the
// read is normal liveness churn: exit code 1 is the empty set (a value), not a
// failure. Every other exit code (timeout, ENOENT, …) is a genuine failure.
export function isRealExecFailure(
  error: Pick<ExecFileException, "code"> | null,
): boolean {
  return error !== null && error.code !== 1;
}

function queryProcesses(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      if (isRealExecFailure(error)) {
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
  const pgrepOut = await queryProcesses("pgrep", ["-P", String(panePid)]);
  if (!pgrepOut.trim()) return [];

  const childPids = pgrepOut
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Get process details
  const psOut = await queryProcesses("ps", [
    "-o",
    "pid=,ppid=,comm=,etime=,cputime=,args=",
    "-p",
    childPids.join(","),
  ]);

  return parsePsOutput(psOut);
}
