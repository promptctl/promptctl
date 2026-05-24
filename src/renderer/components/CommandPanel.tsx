import { useState } from "react";
import { useCommandStore } from "../store/command";
import { useTopology } from "../tmux/proxy";
import type {
  CommandTarget,
  CommandAction,
  CommandTrigger,
  TaskSchedule,
  PaneId,
} from "../../shared/types";

function formatTrigger(trigger: CommandTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "manual";
    case "schedule": {
      const s = trigger.schedule;
      switch (s.kind) {
        case "interval": {
          const secs = s.intervalMs / 1000;
          return secs < 60
            ? `every ${secs}s`
            : `every ${Math.round(secs / 60)}m`;
        }
        case "idle":
          return `idle ${s.idleMs / 1000}s`;
        case "cron":
          return `cron: ${s.expression}`;
      }
      break;
    }
    case "matcher":
      return `/${trigger.pattern}/${trigger.flags}`;
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleTimeString();
}

export function CommandPanel() {
  const commands = useCommandStore((s) => s.commands);
  const events = useCommandStore((s) => s.events);
  const { removeCommand, toggleCommand, fireCommand } = useCommandStore();

  return (
    <div className="space-y-6">
      <AddCommandForm />

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-neutral-300">
          Commands ({commands.length})
        </h3>
        {commands.length === 0 && (
          <p className="text-xs text-neutral-500">No commands defined</p>
        )}
        {commands.map((cmd) => (
          <div
            key={cmd.id}
            className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
          >
            <button
              onClick={() => toggleCommand(cmd.id)}
              className={`h-3 w-3 shrink-0 rounded-full ${cmd.enabled ? "bg-green-500" : "bg-neutral-600"}`}
              title={cmd.enabled ? "Enabled" : "Disabled"}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-neutral-200">{cmd.name}</p>
              <p className="text-xs text-neutral-500">
                {cmd.action.kind} →{" "}
                {cmd.target.kind === "tmux-pane"
                  ? cmd.target.paneId
                  : cmd.target.kind}
                {" · "}trigger: {formatTrigger(cmd.trigger)}
                {" · "}runs: {cmd.runCount} · last: {formatTime(cmd.lastRun)}
              </p>
            </div>
            <button
              onClick={() => fireCommand(cmd.id)}
              className="shrink-0 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
              title="Fire now"
            >
              Run
            </button>
            <button
              onClick={() => removeCommand(cmd.id)}
              className="shrink-0 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {events.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-neutral-300">
            Recent Events
          </h3>
          <div className="max-h-48 overflow-y-auto">
            {events
              .slice()
              .reverse()
              .map((event, i) => (
                <p
                  key={`${event.commandId}-${event.timestamp}-${i}`}
                  className={`text-xs ${
                    event.type === "error"
                      ? "text-red-400"
                      : event.type === "matched"
                        ? "text-blue-400"
                        : "text-neutral-500"
                  }`}
                >
                  {new Date(event.timestamp).toLocaleTimeString()} —{" "}
                  {event.type}
                  {event.detail ? `: ${event.detail.slice(0, 80)}` : ""}
                </p>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AddCommandForm() {
  const panes = useTopology().panes;
  const addCommand = useCommandStore((s) => s.addCommand);

  const [name, setName] = useState("");
  const [targetPaneId, setTargetPaneId] = useState("");
  const [actionKind, setActionKind] =
    useState<CommandAction["kind"]>("send-command");
  const [actionText, setActionText] = useState("");
  const [triggerKind, setTriggerKind] =
    useState<CommandTrigger["kind"]>("manual");
  const [scheduleKind, setScheduleKind] =
    useState<TaskSchedule["kind"]>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [idleSeconds, setIdleSeconds] = useState(30);
  const [cronExpr, setCronExpr] = useState("*/5 * * * *");
  const [matcherPattern, setMatcherPattern] = useState("");
  const [matcherFlags, setMatcherFlags] = useState("i");
  const [matcherPaneId, setMatcherPaneId] = useState("");

  const submit = async () => {
    if (!name || !targetPaneId) return;

    const target: CommandTarget = {
      kind: "tmux-pane",
      paneId: targetPaneId as PaneId,
    };

    const action: CommandAction =
      actionKind === "send-command"
        ? { kind: "send-command", command: actionText }
        : actionKind === "send-keys"
          ? { kind: "send-keys", text: actionText, pressEnter: false }
          : actionKind === "notify"
            ? { kind: "notify", message: actionText }
            : actionKind === "log"
              ? { kind: "log", message: actionText }
              : ({ kind: actionKind } as CommandAction);

    const schedule: TaskSchedule =
      scheduleKind === "interval"
        ? { kind: "interval", intervalMs: intervalMinutes * 60_000 }
        : scheduleKind === "idle"
          ? { kind: "idle", idleMs: idleSeconds * 1000 }
          : { kind: "cron", expression: cronExpr };

    const trigger: CommandTrigger =
      triggerKind === "manual"
        ? { kind: "manual" }
        : triggerKind === "schedule"
          ? { kind: "schedule", schedule }
          : {
              kind: "matcher",
              paneId: matcherPaneId ? (matcherPaneId as PaneId) : null,
              pattern: matcherPattern,
              flags: matcherFlags,
            };

    await addCommand(name, target, action, trigger);
    setName("");
    setActionText("");
    setMatcherPattern("");
  };

  return (
    <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <h3 className="text-sm font-semibold text-neutral-300">Add Command</h3>

      <div className="grid grid-cols-2 gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Command name"
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
        />
        <select
          value={targetPaneId}
          onChange={(e) => setTargetPaneId(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
        >
          <option value="">Target pane...</option>
          {panes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sessionName}:{p.windowName}:{p.paneIndex} ({p.currentCommand})
            </option>
          ))}
        </select>
      </div>

      {/* Action */}
      <div className="flex items-center gap-3">
        <select
          value={actionKind}
          onChange={(e) =>
            setActionKind(e.target.value as CommandAction["kind"])
          }
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
        >
          <option value="send-command">Send Command</option>
          <option value="send-keys">Send Keys</option>
          <option value="notify">Notify</option>
          <option value="log">Log</option>
          <option value="kill-pane">Kill Pane</option>
        </select>
        {(actionKind === "send-command" ||
          actionKind === "send-keys" ||
          actionKind === "notify" ||
          actionKind === "log") && (
          <input
            type="text"
            value={actionText}
            onChange={(e) => setActionText(e.target.value)}
            placeholder={
              actionKind === "send-command"
                ? "Command text"
                : actionKind === "notify"
                  ? "Notification message"
                  : "Text"
            }
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
          />
        )}
      </div>

      {/* Trigger */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={triggerKind}
          onChange={(e) =>
            setTriggerKind(e.target.value as CommandTrigger["kind"])
          }
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
        >
          <option value="manual">Manual</option>
          <option value="schedule">Schedule</option>
          <option value="matcher">Output Matcher</option>
        </select>

        {triggerKind === "schedule" && (
          <>
            <select
              value={scheduleKind}
              onChange={(e) =>
                setScheduleKind(e.target.value as TaskSchedule["kind"])
              }
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
            >
              <option value="interval">Interval</option>
              <option value="idle">On Idle</option>
              <option value="cron">Cron</option>
            </select>
            {scheduleKind === "interval" && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-neutral-500">every</span>
                <input
                  type="number"
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                  min={1}
                  className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
                />
                <span className="text-xs text-neutral-500">min</span>
              </div>
            )}
            {scheduleKind === "idle" && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-neutral-500">after</span>
                <input
                  type="number"
                  value={idleSeconds}
                  onChange={(e) => setIdleSeconds(Number(e.target.value))}
                  min={5}
                  className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
                />
                <span className="text-xs text-neutral-500">sec idle</span>
              </div>
            )}
            {scheduleKind === "cron" && (
              <input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="*/5 * * * *"
                className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-200 outline-none"
              />
            )}
          </>
        )}

        {triggerKind === "matcher" && (
          <>
            <div className="flex items-center gap-1">
              <span className="text-sm text-neutral-500">/</span>
              <input
                type="text"
                value={matcherPattern}
                onChange={(e) => setMatcherPattern(e.target.value)}
                placeholder="regex"
                className="w-40 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-200 outline-none"
              />
              <span className="text-sm text-neutral-500">/</span>
              <input
                type="text"
                value={matcherFlags}
                onChange={(e) => setMatcherFlags(e.target.value)}
                className="w-10 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-200 outline-none"
              />
            </div>
            <select
              value={matcherPaneId}
              onChange={(e) => setMatcherPaneId(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none"
            >
              <option value="">All panes</option>
              {panes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sessionName}:{p.windowName}:{p.paneIndex}
                </option>
              ))}
            </select>
          </>
        )}

        <button
          onClick={submit}
          disabled={!name || !targetPaneId}
          className="ml-auto rounded-lg bg-neutral-700 px-4 py-1.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-600 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}
