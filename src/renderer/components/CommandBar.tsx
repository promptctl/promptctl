import { useState, useCallback, useMemo, useRef, useEffect, type KeyboardEvent } from "react";
import { useTmuxStore } from "../store/tmux";
import { useCommandStore } from "../store/command";

export function CommandBar() {
  const selectedPaneId = useTmuxStore((s) => s.selectedPaneId);
  const pane = useTmuxStore((s) =>
    s.snapshot.panes.find((p) => p.id === s.selectedPaneId),
  );
  const commands = useCommandStore((s) => s.commands);
  const events = useCommandStore((s) => s.events);
  const recentEvents = useMemo(() => events.slice(-5), [events]);
  const fireCommand = useCommandStore((s) => s.fireCommand);

  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter commands by name for suggestions
  const suggestions = input.length > 0
    ? commands.filter((c) =>
        c.name.toLowerCase().includes(input.toLowerCase()),
      ).slice(0, 5)
    : [];

  const sendToPane = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedPaneId) return;
    await window.electronAPI.invoke(
      "tmux:send-keys",
      selectedPaneId,
      text,
      true,
    );
    setInput("");
    setShowSuggestions(false);
  }, [input, selectedPaneId]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // If there's an exact command match, fire it
        const exactMatch = commands.find(
          (c) => c.name.toLowerCase() === input.toLowerCase(),
        );
        if (exactMatch) {
          fireCommand(exactMatch.id);
          setInput("");
          setShowSuggestions(false);
        } else {
          sendToPane();
        }
      } else if (e.key === "Escape") {
        setShowSuggestions(false);
      }
    },
    [sendToPane, commands, input, fireCommand],
  );

  // Close suggestions on outside click
  useEffect(() => {
    const handler = () => setShowSuggestions(false);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  return (
    <div className="relative flex items-center gap-3 border-t border-neutral-800 bg-neutral-900/80 px-4 py-2">
      {/* Context badge */}
      <div className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-[10px] font-mono text-neutral-400">
        {pane
          ? `${pane.sessionName}:${pane.windowName}:${pane.paneIndex}`
          : "no pane"}
      </div>

      {/* Input */}
      <div className="relative flex-1">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(e.target.value.length > 0);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => input.length > 0 && setShowSuggestions(true)}
          placeholder={
            selectedPaneId
              ? "Type command or send to pane..."
              : "Select a pane first..."
          }
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />

        {/* Command suggestions dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1 w-full rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
            {suggestions.map((cmd) => (
              <button
                key={cmd.id}
                onClick={(e) => {
                  e.stopPropagation();
                  fireCommand(cmd.id);
                  setInput("");
                  setShowSuggestions(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800"
              >
                <span className="font-medium">{cmd.name}</span>
                <span className="text-neutral-500">
                  {cmd.trigger.kind} · {cmd.action.kind}
                </span>
                <span
                  className={`ml-auto h-1.5 w-1.5 rounded-full ${cmd.enabled ? "bg-green-500" : "bg-neutral-600"}`}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Recent events */}
      <div className="flex shrink-0 items-center gap-1">
        {recentEvents
          .slice()
          .reverse()
          .map((event, i) => (
            <span
              key={`${event.commandId}-${event.timestamp}-${i}`}
              className={`rounded px-1.5 py-0.5 text-[9px] ${
                event.type === "error"
                  ? "bg-red-500/10 text-red-400"
                  : event.type === "matched"
                    ? "bg-blue-500/10 text-blue-400"
                    : "bg-green-500/10 text-green-400"
              }`}
              title={`${event.type}: ${event.detail ?? ""}`}
            >
              {event.type === "error" ? "ERR" : event.type === "matched" ? "MTH" : "OK"}
            </span>
          ))}
      </div>
    </div>
  );
}
