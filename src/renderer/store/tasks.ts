// [LAW:single-enforcer] Renderer-side view of the task seam. All long-running
// operations show progress and cancel through this hook + TaskToast component.
// [LAW:one-source-of-truth] Task state is derived from "task:event" broadcasts;
// the renderer never tracks it out-of-band.
import { useEffect, useRef, useState } from "react";
import type { TaskEvent } from "../../shared/types";

export interface TaskState {
  kind: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  message?: string;
  error?: string;
}

export const TASK_EVENT_CHANNEL = "task:event";

// Subscribe to lifecycle events for one task. When taskId becomes null, clears.
// Returns null until the "started" event arrives — callers treat null as "no
// active task" and hide the toast.
export function useTaskSubscription(taskId: string | null): TaskState | null {
  const [state, setState] = useState<TaskState | null>(null);
  // Track the current id in a ref so the listener (which never re-registers)
  // can filter events without stale-closure bugs.
  const idRef = useRef<string | null>(taskId);
  idRef.current = taskId;

  useEffect(() => {
    if (!taskId) {
      setState(null);
      return;
    }
    // Start with a placeholder "running" state so the toast can appear
    // immediately even before the first event arrives.
    setState({
      kind: "",
      label: "",
      status: "running",
      done: 0,
      total: 0,
    });

    const off = window.electronAPI.on(
      TASK_EVENT_CHANNEL,
      (...args: unknown[]) => {
        const evt = args[0] as TaskEvent;
        if (!evt || evt.taskId !== idRef.current) return;

        if (evt.type === "started") {
          setState({
            kind: evt.kind,
            label: evt.label,
            status: "running",
            done: 0,
            total: evt.total,
          });
        } else if (evt.type === "progress") {
          setState((s) =>
            s
              ? {
                  ...s,
                  status: "running",
                  done: evt.done,
                  total: evt.total,
                  message: evt.message,
                }
              : s,
          );
        } else if (evt.type === "done") {
          setState((s) => (s ? { ...s, status: "done" } : s));
        } else if (evt.type === "error") {
          setState((s) => (s ? { ...s, status: "error", error: evt.error } : s));
        } else if (evt.type === "cancelled") {
          setState((s) => (s ? { ...s, status: "cancelled" } : s));
        }
      },
    );

    return off;
  }, [taskId]);

  return state;
}

// Fire-and-forget cancel. Main-side runTask does nothing if the id is unknown,
// so this is safe to call even on a task that just finished.
export async function cancelTask(taskId: string): Promise<void> {
  await window.electronAPI.invoke("task:cancel", taskId);
}

// Small id helper — any unique string works. We don't need cryptographic
// uniqueness, just local uniqueness across in-flight tasks.
let counter = 0;
export function newTaskId(): string {
  counter++;
  return `t-${Date.now()}-${counter}`;
}
