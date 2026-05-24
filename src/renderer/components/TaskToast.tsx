// [LAW:one-type-per-behavior] Single toast renders every long-running task.
// Visual surface for useTaskSubscription state. All status lines, progress bars,
// and the cancel button flow through one component so new ops don't fork the UI.
import type { ReactElement } from "react";
import type { TaskState } from "../store/tasks";
import { cancelTask } from "../store/tasks";

interface Props {
  taskId: string | null;
  state: TaskState | null;
  // Fires after the user clicks cancel. Parent clears taskId so the toast hides.
  onClose: () => void;
}

function statusText(state: TaskState): string {
  // Handler-owned message wins when set — it has the richest post-run summary.
  if (state.message) return state.message;
  if (state.status === "done") return "Done";
  if (state.status === "cancelled") return "Cancelled";
  if (state.status === "error")
    return state.error ? `Error: ${state.error}` : "Error";
  if (state.total > 0) return `${state.label} (${state.done}/${state.total})`;
  return state.label || "Working…";
}

function barColor(status: TaskState["status"]): string {
  if (status === "done") return "bg-emerald-500";
  if (status === "error") return "bg-red-500";
  if (status === "cancelled") return "bg-neutral-500";
  return "bg-violet-500";
}

export function TaskToast({
  taskId,
  state,
  onClose,
}: Props): ReactElement | null {
  if (!taskId || !state) return null;

  const running = state.status === "running";
  const pct =
    state.total > 0
      ? Math.min(100, Math.round((state.done / state.total) * 100))
      : running
        ? 0
        : 100;

  return (
    <div
      data-testid="task-toast"
      className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2 rounded-lg border border-violet-700 bg-violet-950 px-4 py-3 text-sm text-violet-200 shadow-2xl"
    >
      <div className="flex items-center gap-3">
        {running && (
          <span
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-violet-400 border-t-transparent"
            aria-hidden="true"
          />
        )}
        <span className="flex-1 truncate" title={statusText(state)}>
          {statusText(state)}
        </span>
        {running ? (
          <button
            data-testid="task-toast-cancel"
            onClick={() => {
              // Fire cancel; the close happens when the "cancelled" event
              // returns and parent clears the id. We don't optimistically close
              // so the user sees the transition.
              void cancelTask(taskId);
            }}
            className="rounded bg-violet-800 px-2 py-0.5 text-xs font-medium text-violet-100 hover:bg-violet-700"
          >
            Cancel
          </button>
        ) : (
          <button
            data-testid="task-toast-dismiss"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-xs font-medium text-violet-400 hover:bg-violet-800 hover:text-violet-100"
          >
            Dismiss
          </button>
        )}
      </div>

      {/* Progress bar — determinate when total is known, indeterminate pulse otherwise */}
      <div className="h-1.5 overflow-hidden rounded bg-violet-900">
        {state.total > 0 || !running ? (
          <div
            data-testid="task-toast-bar"
            className={`h-full transition-all ${barColor(state.status)}`}
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div
            data-testid="task-toast-bar"
            className={`h-full w-1/3 animate-pulse ${barColor(state.status)}`}
          />
        )}
      </div>
    </div>
  );
}
