// [LAW:single-enforcer] Socket ownership and process ancestry are resolved
// only in this module; proxy event construction consumes ClientInfo values.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type net from "node:net";
import { platform } from "node:os";
import { readFile, readlink, readdir } from "node:fs/promises";

import type { ClientInfo } from "../../shared/proxy-events";

const CLIENT_BINS = new Set(["claude", "codex", "gemini", "copilot-cli"]);
const RESOLVE_TIMEOUT_MS = 300;
const MAX_PARENT_DEPTH = 10;

interface ProcessRow {
  pid: number;
  ppid: number;
  comm: string;
}

function exec(cmd: string, args: string[], timeout = RESOLVE_TIMEOUT_MS): Promise<string> {
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
  const fallback = fallbackClient(socket);
  const resolved = await Promise.race([
    resolveClientInfo(socket).catch(() => fallback),
    new Promise<ClientInfo>((resolve) => setTimeout(() => resolve(fallback), RESOLVE_TIMEOUT_MS)),
  ]);
  return resolved;
}

async function resolveClientInfo(socket: net.Socket): Promise<ClientInfo> {
  const pid = await findSocketPid(socket);
  const root = await findClientRoot(pid);
  const command = await readCommand(root.pid);
  const cwd = await readCwd(root.pid);
  const shortCwd = cwd ? basename(cwd) || cwd : "unknown cwd";
  const binary = basename(root.comm || command?.split(/\s+/)[0] || `pid ${root.pid}`);
  return {
    clientId: String(root.pid),
    pid,
    rootPid: root.pid,
    displayName: `${binary} @ ${shortCwd}`,
    command,
    cwd,
    lastSeenNs: nowNs(),
  };
}

async function findSocketPid(socket: net.Socket): Promise<number> {
  const remotePort = socket.remotePort;
  if (remotePort === undefined) throw new Error("socket remotePort unavailable");
  if (platform() === "linux") return findLinuxSocketPid(socket);
  return findMacSocketPid(remotePort);
}

async function findMacSocketPid(remotePort: number): Promise<number> {
  const stdout = await exec("lsof", [
    "-nP",
    "-iTCP",
    `-iTCP:${remotePort}`,
    "-sTCP:ESTABLISHED",
    "-Fpn",
  ]);
  const pid = parseLsofPid(stdout);
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
      if (local.endsWith(`:${localHex}`) && remote.endsWith(`:${remoteHex}`) && inode) {
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
  const line = stdout.split("\n").find((part) => part.startsWith("p"));
  const pid = line ? Number(line.slice(1)) : NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function findClientRoot(pid: number): Promise<ProcessRow> {
  let current = await readProcess(pid);
  let selected = current;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    if (CLIENT_BINS.has(basename(current.comm))) selected = current;
    if (current.ppid <= 1) break;
    current = await readProcess(current.ppid);
  }
  return selected;
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
    const stdout = await exec("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"]);
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
  };
}

function nowNs(): number {
  return Number(process.hrtime.bigint());
}
