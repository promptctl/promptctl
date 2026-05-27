import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  type KeyboardEvent,
} from "react";
import { usePaneSelectionStore } from "../store/pane-selection";
import { useCommandStore } from "../store/command";
import { getTmuxProxy, useTopology } from "../tmux/proxy";
import { recordHistory, getHistory } from "../lib/composer-history";

const MAX_ROWS = 6;
const DRAFT_INDEX = -1;

// [LAW:dataflow-not-control-flow] cursorOnFirstLine / cursorOnLastLine read
// the textarea's selection and content as data; the history key handler
// dispatches on the values rather than threading a "history mode" boolean.
function cursorOnFirstLine(el: HTMLTextAreaElement): boolean {
  return el.value.substring(0, el.selectionStart).indexOf("\n") === -1;
}
function cursorOnLastLine(el: HTMLTextAreaElement): boolean {
  return el.value.substring(el.selectionEnd).indexOf("\n") === -1;
}

export function CommandBar() {
  const selectedPaneId = usePaneSelectionStore((s) => s.selectedPaneId);
  const topology = useTopology();
  const pane = topology.panes.find((p) => p.id === selectedPaneId);
  const commands = useCommandStore((s) => s.commands);
  const events = useCommandStore((s) => s.events);
  const recentEvents = useMemo(() => events.slice(-5), [events]);
  const fireCommand = useCommandStore((s) => s.fireCommand);

  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  // historyIndex = DRAFT_INDEX means "user's live draft"; 0..N-1 indexes the
  // ring (N-1 is the most recent entry, 0 is the oldest).
  const [historyIndex, setHistoryIndex] = useState(DRAFT_INDEX);
  const draftRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const suggestions =
    input.length > 0 && !input.includes("\n")
      ? commands
          .filter((c) => c.name.toLowerCase().includes(input.toLowerCase()))
          .slice(0, 5)
      : [];

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    const exactMatch = commands.find(
      (c) => c.name.toLowerCase() === text.toLowerCase(),
    );
    try {
      if (exactMatch) {
        await fireCommand(exactMatch.id);
      } else {
        // Pane is required only for the literal-keys path; command fire is
        // pane-agnostic (target.kind may be tmux-session/window/app).
        if (!selectedPaneId) return;
        // [LAW:one-source-of-truth] The library's TmuxClientProxy is the single
        // renderer-side surface for tmux operations. `sendKeys` sends literally
        // (`-l`), so embedded "\n" is delivered as a newline and the trailing
        // "\r" is the submit. Multi-line input goes through one send.
        await getTmuxProxy().sendKeys(selectedPaneId, text + "\r");
      }
    } catch (err) {
      // Log so failures are visible in the dev console; no swallow. The
      // input stays in place so the user can retry without retyping.
      console.error("CommandBar submit failed", err);
      return;
    }
    recordHistory(text);
    setInput("");
    setHistoryIndex(DRAFT_INDEX);
    draftRef.current = "";
    setShowSuggestions(false);
  }, [input, selectedPaneId, commands, fireCommand]);

  const stepHistory = useCallback(
    (direction: "older" | "newer"): boolean => {
      const ring = getHistory();
      const stepTo = (next: number): boolean => {
        const value = ring[next];
        if (value === undefined) return false;
        setHistoryIndex(next);
        setInput(value);
        return true;
      };

      if (direction === "older") {
        if (historyIndex === DRAFT_INDEX) {
          draftRef.current = input;
          return stepTo(ring.length - 1);
        }
        if (historyIndex > 0) return stepTo(historyIndex - 1);
        return false;
      }

      if (historyIndex === DRAFT_INDEX) return false;
      if (historyIndex < ring.length - 1) return stepTo(historyIndex + 1);
      setHistoryIndex(DRAFT_INDEX);
      setInput(draftRef.current);
      return true;
    },
    [historyIndex, input],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
        return;
      }
      if (e.key === "Escape") {
        setShowSuggestions(false);
        return;
      }
      const el = e.currentTarget;
      if (e.key === "ArrowUp" && cursorOnFirstLine(el)) {
        if (stepHistory("older")) e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown" && cursorOnLastLine(el)) {
        if (stepHistory("newer")) e.preventDefault();
      }
    },
    [submit, stepHistory],
  );

  useEffect(() => {
    const handler = () => setShowSuggestions(false);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const rows = Math.min(MAX_ROWS, input.split("\n").length);

  return (
    <div className="relative flex items-end gap-3 border-t border-neutral-800 bg-neutral-900/80 px-4 py-2">
      <div className="shrink-0 self-center rounded bg-neutral-800 px-2 py-1 text-[10px] font-mono text-neutral-400">
        {pane
          ? `${pane.sessionName}:${pane.windowName}:${pane.paneIndex}`
          : "no pane"}
      </div>

      <div className="relative flex-1">
        <textarea
          ref={textareaRef}
          data-testid="loops-composer-input"
          aria-label="Command composer"
          value={input}
          rows={rows}
          onChange={(e) => {
            setInput(e.target.value);
            // Typing exits history mode and resets the draft cache to the
            // current text — Up afterward will re-snapshot from here.
            if (historyIndex !== DRAFT_INDEX) setHistoryIndex(DRAFT_INDEX);
            draftRef.current = e.target.value;
            setShowSuggestions(
              e.target.value.length > 0 && !e.target.value.includes("\n"),
            );
          }}
          onKeyDown={onKeyDown}
          onFocus={() =>
            input.length > 0 &&
            !input.includes("\n") &&
            setShowSuggestions(true)
          }
          placeholder={
            selectedPaneId
              ? "Type to send to pane — Enter submits, Shift+Enter newline, ↑/↓ history"
              : "Select a pane first..."
          }
          className="w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm leading-5 text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />

        {showSuggestions && suggestions.length > 0 && (
          <div
            data-testid="loops-composer-suggestions"
            className="absolute bottom-full left-0 mb-1 w-full rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
          >
            {suggestions.map((cmd) => (
              <button
                key={cmd.id}
                onClick={(e) => {
                  e.stopPropagation();
                  fireCommand(cmd.id);
                  recordHistory(cmd.name);
                  setInput("");
                  setHistoryIndex(DRAFT_INDEX);
                  draftRef.current = "";
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

      <div className="flex shrink-0 items-center gap-1 self-center">
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
              {event.type === "error"
                ? "ERR"
                : event.type === "matched"
                  ? "MTH"
                  : "OK"}
            </span>
          ))}
      </div>
    </div>
  );
}
