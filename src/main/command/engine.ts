// [LAW:single-enforcer] All command execution goes through here.
// [LAW:one-type-per-behavior] Unifies former SchedulerEngine + MatcherEngine.
// [LAW:locality-or-seam] The engine consumes tmux through a single seam
// (CommandEngineDeps) — three methods: byte stream in, send-keys out, execute
// out. Production wires them to TmuxControlConnection; tests pass a fake.
// Nothing in this file imports the tmux library or the connection class — the
// type is the only surface.

import type {
  Command,
  CommandEvent,
  PaneId,
  TaskSchedule,
} from "../../shared/types";
import type { WebContents } from "electron";
import { Notification } from "electron";
import { parseCron, nextCronOccurrence } from "./cron";
import { tmuxEscape } from "tmux-control-mode-js/protocol";

export interface CommandEngineDeps {
  // [LAW:dataflow-not-control-flow] Output flows through one handler shape —
  // the same `(paneId, data) => void` for every pane, every byte. The engine
  // doesn't ask "is this the pane I care about" at subscribe time; it filters
  // per command at match time.
  onOutput(handler: (paneId: PaneId, data: string) => void): () => void;
  // Send a literal key sequence to a pane (-l semantics: bytes flow as-is,
  // no key-name interpretation). Append "\r" upstream for Enter.
  sendKeys(target: PaneId, keys: string): Promise<void>;
  // Run any tmux command. Used for kill-pane and capture-pane actions.
  execute(command: string): Promise<void>;
}

export class CommandEngine {
  private commands = new Map<string, Command>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private compiled = new Map<string, RegExp>();
  private lineBuffers = new Map<string, string>();
  private subscribers = new Set<WebContents>();
  private lastActivity = new Map<string, number>();
  private unsubOutput: (() => void) | null = null;

  constructor(private readonly deps: CommandEngineDeps) {}

  subscribe(webContents: WebContents): void {
    this.subscribers.add(webContents);
    webContents.once("destroyed", () => this.subscribers.delete(webContents));
  }

  start(): void {
    this.unsubOutput = this.deps.onOutput((paneId, data) => {
      this.recordActivity(paneId);
      this.processOutput(paneId, data);
    });
  }

  stop(): void {
    this.unsubOutput?.();
    this.unsubOutput = null;
    for (const [id] of this.timers) {
      this.cancelTimer(id);
    }
  }

  recordActivity(paneId: PaneId): void {
    this.lastActivity.set(paneId, Date.now());
  }

  getCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  addCommand(command: Command): void {
    this.commands.set(command.id, command);
    if (command.enabled) this.setupTrigger(command);
    this.broadcastCommands();
  }

  removeCommand(id: string): void {
    this.teardownTrigger(id);
    this.commands.delete(id);
    this.broadcastCommands();
  }

  updateCommand(id: string, updates: Partial<Command>): void {
    const command = this.commands.get(id);
    if (!command) return;

    const wasEnabled = command.enabled;
    Object.assign(command, updates);

    this.teardownTrigger(id);
    if (command.enabled) this.setupTrigger(command);
    if (wasEnabled && !command.enabled) this.teardownTrigger(id);

    this.broadcastCommands();
  }

  loadCommands(commands: Command[]): void {
    for (const command of commands) {
      this.commands.set(command.id, command);
      if (command.enabled) this.setupTrigger(command);
    }
  }

  async fireCommand(id: string): Promise<void> {
    const command = this.commands.get(id);
    if (!command) return;
    await this.executeAction(command);
  }

  // --- Trigger management ---

  private setupTrigger(command: Command): void {
    const trigger = command.trigger;
    switch (trigger.kind) {
      case "manual":
        break;
      case "schedule":
        this.scheduleTimer(command);
        break;
      case "matcher":
        this.compileMatcher(command);
        break;
    }
  }

  private teardownTrigger(id: string): void {
    this.cancelTimer(id);
    this.compiled.delete(id);
  }

  private scheduleTimer(command: Command): void {
    const trigger = command.trigger;
    if (trigger.kind !== "schedule") return;

    const delayMs = this.computeDelay(command, trigger.schedule);
    const timer = setTimeout(() => this.onTimerFire(command), delayMs);
    this.timers.set(command.id, timer);
  }

  private computeDelay(command: Command, schedule: TaskSchedule): number {
    switch (schedule.kind) {
      case "interval":
        return schedule.intervalMs;
      case "idle": {
        const targetPaneId =
          command.target.kind === "tmux-pane" ? command.target.paneId : null;
        const last = targetPaneId
          ? (this.lastActivity.get(targetPaneId) ?? Date.now())
          : Date.now();
        const elapsed = Date.now() - last;
        return Math.max(0, schedule.idleMs - elapsed);
      }
      case "cron": {
        const parsed = parseCron(schedule.expression);
        const next = nextCronOccurrence(parsed);
        return Math.max(0, next.getTime() - Date.now());
      }
    }
  }

  private async onTimerFire(command: Command): Promise<void> {
    this.timers.delete(command.id);

    if (
      command.trigger.kind === "schedule" &&
      command.trigger.schedule.kind === "idle" &&
      command.target.kind === "tmux-pane"
    ) {
      const last = this.lastActivity.get(command.target.paneId) ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < command.trigger.schedule.idleMs) {
        this.scheduleTimer(command);
        return;
      }
    }

    await this.executeAction(command);

    if (command.enabled && command.trigger.kind === "schedule") {
      this.scheduleTimer(command);
    }
  }

  private compileMatcher(command: Command): void {
    if (command.trigger.kind !== "matcher") return;
    try {
      this.compiled.set(
        command.id,
        new RegExp(command.trigger.pattern, command.trigger.flags),
      );
    } catch {
      this.compiled.delete(command.id);
    }
  }

  // eslint-disable-next-line no-control-regex
  private static ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

  private processOutput(paneId: PaneId, data: string): void {
    const existing = this.lineBuffers.get(paneId) ?? "";
    const full = existing + data;
    const lines = full.split("\n");
    this.lineBuffers.set(paneId, lines.pop() ?? "");

    const stripped = lines
      .map((line) => line.replace(CommandEngine.ANSI_PATTERN, ""))
      .join("\n");

    if (stripped.length === 0) return;

    for (const [id, command] of this.commands) {
      if (!command.enabled) continue;
      if (command.trigger.kind !== "matcher") continue;
      if (command.trigger.paneId !== null && command.trigger.paneId !== paneId)
        continue;

      const regex = this.compiled.get(id);
      if (!regex) continue;

      regex.lastIndex = 0;
      const match = regex.exec(stripped);
      if (!match) continue;

      this.emitEvent({
        commandId: command.id,
        type: "matched",
        timestamp: Date.now(),
        detail: match[0].slice(0, 200),
      });

      this.executeAction(command);
    }
  }

  // --- Action execution ---

  private async executeAction(command: Command): Promise<void> {
    try {
      const action = command.action;

      switch (action.kind) {
        case "send-keys": {
          const paneId = this.resolveTargetPane(command);
          if (paneId)
            await this.deps.sendKeys(
              paneId,
              action.pressEnter ? action.text + "\r" : action.text,
            );
          break;
        }
        case "send-command": {
          const paneId = this.resolveTargetPane(command);
          // [LAW:dataflow-not-control-flow] send-command is send-keys with
          // pressEnter=true baked in — same dep path, just data differs.
          if (paneId) await this.deps.sendKeys(paneId, action.command + "\r");
          break;
        }
        case "notify": {
          const notification = new Notification({
            title: `promptctl: ${command.name}`,
            body: action.message,
          });
          notification.show();
          break;
        }
        case "capture-output": {
          const paneId = this.resolveTargetPane(command);
          if (paneId)
            await this.deps.execute(
              `capture-pane -t ${tmuxEscape(paneId)} -p -e -J -S -500`,
            );
          break;
        }
        case "kill-pane": {
          const paneId = this.resolveTargetPane(command);
          if (paneId)
            await this.deps.execute(`kill-pane -t ${tmuxEscape(paneId)}`);
          break;
        }
        case "log":
          break;
      }

      command.lastRun = Date.now();
      command.runCount++;
      this.emitEvent({
        commandId: command.id,
        type: "fired",
        timestamp: Date.now(),
        detail: action.kind,
      });

      this.broadcastCommands();
    } catch (e) {
      this.emitEvent({
        commandId: command.id,
        type: "error",
        timestamp: Date.now(),
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private resolveTargetPane(command: Command): PaneId | null {
    if (command.target.kind === "tmux-pane") return command.target.paneId;
    return null;
  }

  // --- Broadcasting ---

  private cancelTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private emitEvent(event: CommandEvent): void {
    for (const wc of this.subscribers) {
      if (!wc.isDestroyed()) {
        wc.send("command:event", event);
      }
    }
  }

  private broadcastCommands(): void {
    const commands = this.getCommands();
    for (const wc of this.subscribers) {
      if (!wc.isDestroyed()) {
        wc.send("command:list", commands);
      }
    }
  }
}
