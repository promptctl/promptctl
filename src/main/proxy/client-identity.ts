// [LAW:single-enforcer] Socket ownership and process ancestry are resolved
// only in this module; proxy event construction consumes ClientInfo values.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type net from "node:net";
import type http from "node:http";
import { platform } from "node:os";
import { readFile, readlink, readdir } from "node:fs/promises";

import type { ClientInfo } from "../../shared/proxy-events";
import type { Launch, LaunchId } from "../../shared/types";

// [LAW:one-source-of-truth] Identity is derived from kernel state (peer pid)
// and a deterministic walk to a stable ancestor — same logical process always
// produces the same clientId, regardless of which socket we resolved through.
//
// Stop the walk before crossing into shell/terminal/init: those are shared
// across unrelated programs, so coalescing on them would merge two claudes
// in two tmux panes into one tab. The "topmost non-shell ancestor" is "the
// program the user launched", which is the granularity we want.
const SHELL_OR_LAUNCHER_COMMS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tmux",
  "tmux-server",
  "screen",
  "login",
  "sshd",
  "init",
  "launchd",
  "systemd",
  "Terminal",
  "iTerm2",
  "WindowServer",
]);
const RESOLVE_DEADLINE_MS = 3000;
const PEER_LOOKUP_RETRIES = 6;
const PEER_LOOKUP_BACKOFF_MS = 80;
const MAX_PARENT_DEPTH = 16;
const PER_EXEC_TIMEOUT_MS = 600;

interface CacheEntry {
  readonly info: ClientInfo;
  readonly peerComm: string | null;
}

// [LAW:single-enforcer] Module-singleton cache keyed by peer pid. Two sockets
// from the same peer pid skip the walk; two peers under the same root walk
// independently but converge on the same clientId, so they tab together.
//
// Cache hits revalidate against the live peer pid's comm (one ps exec) so a
// pid reused by a different program doesn't serve stale identity.
const peerCache = new Map<number, CacheEntry>();

export interface ProcessRow {
  pid: number;
  ppid: number;
  comm: string;
}

function exec(
  cmd: string,
  args: string[],
  timeout = PER_EXEC_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function resolveClientId(socket: net.Socket): Promise<ClientInfo> {
  // [LAW:dataflow-not-control-flow] Always attempt resolution; only fall back
  // when the deadline genuinely expires. The previous code raced a 1s timer
  // against the resolver and returned "unknown" on every slow lsof, which
  // produced ghost clients for the same real process.
  const fallback = fallbackClient(socket);
  return Promise.race([
    resolveClientInfo(socket).catch(() => fallback),
    new Promise<ClientInfo>((resolve) =>
      setTimeout(() => resolve(fallback), RESOLVE_DEADLINE_MS),
    ),
  ]);
}

// Builds a ClientInfo from a launch row. Used by the request-time
// resolver when the proxy header tags a launch we know about — gives
// O(1), deterministic identity attribution and short-circuits the
// socket→pid walk entirely.
//
// [LAW:one-source-of-truth] The launch is the canonical identity for
// traffic from a tool we spawned. The socket walk is the fallback for
// untagged traffic (a user runs a stray `claude` outside promptctl).
export function clientInfoFromLaunch(launch: Launch): ClientInfo {
  const shortCwd = basename(launch.cwd) || launch.cwd || "unknown cwd";
  const pid =
    launch.status === "running" || launch.status === "exited"
      ? launch.pid
      : null;
  return {
    clientId: `launch-${launch.launchId}`,
    pid,
    rootPid: pid,
    displayName: `${launch.toolKind} @ ${shortCwd}`,
    command: launch.toolKind,
    cwd: launch.cwd,
    lastSeenNs: nowNs(),
    launchId: launch.launchId,
  };
}

// Resolves the client identity for an HTTP request. Header-based
// attribution comes first — when the request carries
// `X-Promptctl-Launch: <id>` and that id maps to a known launch row,
// we return that row's ClientInfo. Otherwise we fall back to the
// existing socket→pid walk and add `launchId: null` to the result.
//
// [LAW:dataflow-not-control-flow] Same shape returned on every path —
// the variability is in which input was authoritative, not in whether
// the resolver produced output.
//
// The `socketFallback` parameter is injectable so unit tests can drive
// the fallback path without invoking the real socket walk (which does
// real lsof/ps and is slow / environment-sensitive). Production omits
// it and the default points at `resolveClientId`.
export async function resolveRequestClient(
  req: http.IncomingMessage,
  socket: net.Socket,
  resolveLaunch: (id: LaunchId) => Launch | null,
  socketFallback: (socket: net.Socket) => Promise<ClientInfo> = resolveClientId,
): Promise<ClientInfo> {
  const header = readLaunchHeader(req);
  if (header !== null) {
    const launch = resolveLaunch(header);
    if (launch !== null) {
      return clientInfoFromLaunch(launch);
    }
    // Header was present but doesn't match a known launch — e.g. the
    // launch row was evicted, or the user reproduced the env var
    // outside our control. Fall back to the socket walk rather than
    // synthesizing a phantom row from header data we can't verify.
  }
  return socketFallback(socket);
}

// Exported for unit testing. Returns the launchId from the request's
// `X-Promptctl-Launch` header, or null if absent / malformed. When the
// header repeats, scan for the first non-empty value (rather than
// blindly using index 0, which may itself be empty whitespace and
// would discard a real id later in the list).
export function readLaunchHeader(req: http.IncomingMessage): LaunchId | null {
  const raw = req.headers["x-promptctl-launch"];
  if (raw === undefined) return null;
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed as LaunchId;
  }
  return null;
}

async function resolveClientInfo(socket: net.Socket): Promise<ClientInfo> {
  const pid = await findSocketPidWithRetry(socket);
  const cached = await consumeCacheHit(pid);
  if (cached) return cached;
  const root = await findClientRoot(pid);
  const command = await readCommand(root.pid);
  const cwd = await readCwd(root.pid);
  const shortCwd = cwd ? basename(cwd) || cwd : "unknown cwd";
  const binary = basename(
    root.comm || command?.split(/\s+/)[0] || `pid ${root.pid}`,
  );
  const info: ClientInfo = {
    clientId: String(root.pid),
    pid,
    rootPid: root.pid,
    displayName: `${binary} @ ${shortCwd}`,
    command,
    cwd,
    lastSeenNs: nowNs(),
    launchId: null,
  };
  peerCache.set(pid, { info, peerComm: await readComm(pid) });
  return info;
}

// Validate the cache entry against the live process before serving it: if the
// peer pid was reused by a different program (different comm), the cached
// clientId is stale and would mis-attribute traffic. Cheap fast-path on hit
// (one ps exec) vs a full walk on miss (three+).
async function consumeCacheHit(pid: number): Promise<ClientInfo | null> {
  const cached = peerCache.get(pid);
  if (!cached) return null;
  const liveComm = await readComm(pid);
  if (liveComm === null || liveComm !== cached.peerComm) {
    peerCache.delete(pid);
    return null;
  }
  return { ...cached.info, lastSeenNs: nowNs() };
}

async function readComm(pid: number): Promise<string | null> {
  try {
    const stdout = await exec("ps", ["-o", "comm=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function findSocketPidWithRetry(socket: net.Socket): Promise<number> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < PEER_LOOKUP_RETRIES; attempt += 1) {
    try {
      return await findSocketPid(socket);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, PEER_LOOKUP_BACKOFF_MS));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("findSocketPid: unknown failure");
}

async function findSocketPid(socket: net.Socket): Promise<number> {
  const remotePort = socket.remotePort;
  if (remotePort === undefined)
    throw new Error("socket remotePort unavailable");
  if (platform() === "linux") return findLinuxSocketPid(socket);
  return findMacSocketPid(socket);
}

async function findMacSocketPid(socket: net.Socket): Promise<number> {
  const remotePort = socket.remotePort;
  const localPort = socket.localPort;
  if (remotePort === undefined || localPort === undefined) {
    throw new Error("socket ports unavailable");
  }
  const stdout = await exec("lsof", [
    "-nP",
    "-iTCP",
    `-iTCP:${remotePort}`,
    "-sTCP:ESTABLISHED",
    "-Fpn",
  ]);
  const entries = parseLsofEntries(stdout);
  const peer = entries.find(
    (entry) =>
      entry.name.includes(`:${remotePort}->`) &&
      entry.name.includes(`:${localPort}`),
  );
  const candidates = entries.map((entry) => entry.pid);
  const pid =
    peer?.pid ??
    candidates.find((candidate) => candidate !== process.pid) ??
    candidates[0] ??
    null;
  if (pid === null) throw new Error("no socket pid from lsof");
  return pid;
}

async function findLinuxSocketPid(socket: net.Socket): Promise<number> {
  const inode = await findLinuxSocketInode(socket);
  const procEntries = await readdir("/proc", { withFileTypes: true });
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const fdDir = `/proc/${pid}/fd`;
    let fds: string[];
    try {
      fds = await readdir(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`${fdDir}/${fd}`);
        if (target === `socket:[${inode}]`) return pid;
      } catch {
        // Process exited or fd disappeared while scanning; keep scanning.
      }
    }
  }
  throw new Error("no socket pid from /proc");
}

async function findLinuxSocketInode(socket: net.Socket): Promise<string> {
  const remotePort = socket.remotePort;
  const localPort = socket.localPort;
  if (remotePort === undefined || localPort === undefined) {
    throw new Error("socket ports unavailable");
  }
  const tables = await Promise.all([
    readFile("/proc/net/tcp", "utf8"),
    readFile("/proc/net/tcp6", "utf8").catch(() => ""),
  ]);
  const localHex = portHex(localPort);
  const remoteHex = portHex(remotePort);
  for (const table of tables) {
    for (const line of table.trim().split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? "";
      const remote = cols[2] ?? "";
      const inode = cols[9] ?? "";
      if (
        local.endsWith(`:${localHex}`) &&
        remote.endsWith(`:${remoteHex}`) &&
        inode
      ) {
        return inode;
      }
    }
  }
  throw new Error("socket inode unavailable");
}

function portHex(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, "0");
}

export function parseLsofPid(stdout: string): number | null {
  return parseLsofPids(stdout)[0] ?? null;
}

export function parseLsofPids(stdout: string): number[] {
  return parseLsofEntries(stdout).map((entry) => entry.pid);
}

export function parseLsofEntries(
  stdout: string,
): { pid: number; name: string }[] {
  const entries: { pid: number; name: string }[] = [];
  let currentPid: number | null = null;
  for (const part of stdout.split("\n")) {
    if (part.startsWith("p")) {
      const pid = Number(part.slice(1));
      currentPid = Number.isFinite(pid) && pid > 0 ? pid : null;
    } else if (part.startsWith("n") && currentPid !== null) {
      entries.push({ pid: currentPid, name: part.slice(1) });
    }
  }
  return entries;
}

async function findClientRoot(pid: number): Promise<ProcessRow> {
  return walkToClientRoot(pid, readProcess);
}

// Exported for unit testing. The walk algorithm is pulled out of any I/O so
// tests can drive it with a deterministic process table.
//
// [LAW:dataflow-not-control-flow] Walk to a deterministic root. Stop *before*
// crossing into a shell/launcher: that's where unrelated programs converge,
// so coalescing past it would merge two CLIs in two tmux panes into one tab.
// The previous heuristic looked for a known CLI name (claude/codex/gemini) and
// fell through to the peer pid when no match was found — meaning the same
// logical process produced different roots per socket depending on whether
// the walk happened to hit a name match. This walk produces the same answer
// for every descendant of one launched program.
export async function walkToClientRoot(
  pid: number,
  readProcessRow: (pid: number) => Promise<ProcessRow>,
): Promise<ProcessRow> {
  let current = await readProcessRow(pid);
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    if (current.ppid <= 1) break;
    let parent: ProcessRow;
    try {
      parent = await readProcessRow(current.ppid);
    } catch {
      break;
    }
    if (SHELL_OR_LAUNCHER_COMMS.has(basename(parent.comm))) break;
    current = parent;
  }
  return current;
}

// Test-only escape hatch. Cache state is process-scoped; tests need a clean
// slate between cases.
export function __resetPeerCacheForTesting(): void {
  peerCache.clear();
}

async function readProcess(pid: number): Promise<ProcessRow> {
  const stdout = await exec("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
  const trimmed = stdout.trim();
  const [ppidText, ...commParts] = trimmed.split(/\s+/);
  const ppid = Number(ppidText);
  if (!Number.isFinite(ppid)) throw new Error(`invalid ps output for ${pid}`);
  return { pid, ppid, comm: commParts.join(" ") };
}

async function readCommand(pid: number): Promise<string | null> {
  try {
    const stdout = await exec("ps", ["-o", "command=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readCwd(pid: number): Promise<string | null> {
  try {
    if (platform() === "linux") return await readlink(`/proc/${pid}/cwd`);
    const stdout = await exec("lsof", [
      "-p",
      String(pid),
      "-a",
      "-d",
      "cwd",
      "-Fn",
    ]);
    const line = stdout.split("\n").find((part) => part.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function fallbackClient(socket: net.Socket): ClientInfo {
  const port = socket.remotePort ?? 0;
  return {
    clientId: `socket-${port}`,
    pid: null,
    rootPid: null,
    displayName: `unknown client (socket ${port})`,
    command: null,
    cwd: null,
    lastSeenNs: nowNs(),
    launchId: null,
  };
}

function nowNs(): number {
  return Number(process.hrtime.bigint());
}
