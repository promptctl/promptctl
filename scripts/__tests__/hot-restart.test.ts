import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHotRestart, type HotRestartHandle } from "../dev/hot-restart";

const flushFsWatch = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("startHotRestart", () => {
  let dir: string;
  let handle: HotRestartHandle | null = null;
  let restarts: string[][];
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hot-restart-"));
    restarts = [];
    logs = [];
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("triggers restart when a watched file changes", async () => {
    handle = startHotRestart({
      buildDir: dir,
      restartFiles: new Set(["main.js"]),
      debounceMs: 30,
      triggerRestart: (files) => restarts.push(files),
      log: (msg) => logs.push(msg),
    });
    writeFileSync(path.join(dir, "main.js"), "x");
    await flushFsWatch(150);
    expect(restarts).toEqual([["main.js"]]);
    expect(logs[0]).toContain("main.js changed");
  });

  it("debounces rapid changes into a single restart with all changed files", async () => {
    handle = startHotRestart({
      buildDir: dir,
      restartFiles: new Set(["main.js", "preload.js"]),
      debounceMs: 80,
      triggerRestart: (files) => restarts.push(files),
      log: (msg) => logs.push(msg),
    });
    writeFileSync(path.join(dir, "main.js"), "1");
    writeFileSync(path.join(dir, "preload.js"), "1");
    writeFileSync(path.join(dir, "main.js"), "2");
    await flushFsWatch(250);
    expect(restarts).toEqual([["main.js", "preload.js"]]);
  });

  it("ignores files outside the restartFiles set", async () => {
    handle = startHotRestart({
      buildDir: dir,
      restartFiles: new Set(["main.js"]),
      debounceMs: 30,
      triggerRestart: (files) => restarts.push(files),
      log: (msg) => logs.push(msg),
    });
    writeFileSync(path.join(dir, "renderer.js"), "x");
    writeFileSync(path.join(dir, "assets.css"), "x");
    await flushFsWatch(150);
    expect(restarts).toEqual([]);
  });

  it("creates the buildDir if it does not yet exist", async () => {
    const nested = path.join(dir, "does-not-exist-yet");
    handle = startHotRestart({
      buildDir: nested,
      restartFiles: new Set(["main.js"]),
      debounceMs: 30,
      triggerRestart: (files) => restarts.push(files),
      log: (msg) => logs.push(msg),
    });
    writeFileSync(path.join(nested, "main.js"), "x");
    await flushFsWatch(150);
    expect(restarts).toEqual([["main.js"]]);
  });

  it("stop() cancels pending restarts and prevents future ones", async () => {
    handle = startHotRestart({
      buildDir: dir,
      restartFiles: new Set(["main.js"]),
      debounceMs: 100,
      triggerRestart: (files) => restarts.push(files),
      log: (msg) => logs.push(msg),
    });
    writeFileSync(path.join(dir, "main.js"), "1");
    handle.stop();
    handle = null;
    await flushFsWatch(200);
    expect(restarts).toEqual([]);
  });

  it("subsequent changes after a fired restart trigger another restart", async () => {
    handle = startHotRestart({
      buildDir: dir,
      restartFiles: new Set(["main.js"]),
      debounceMs: 30,
      triggerRestart: (files) => restarts.push(files),
      log: (msg) => logs.push(msg),
    });
    writeFileSync(path.join(dir, "main.js"), "1");
    await flushFsWatch(150);
    writeFileSync(path.join(dir, "main.js"), "2");
    await flushFsWatch(150);
    expect(restarts).toEqual([["main.js"], ["main.js"]]);
  });
});
