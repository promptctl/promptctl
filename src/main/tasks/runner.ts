// [LAW:single-enforcer] Every long-running main-process operation flows through
// runTask. One registry, one event channel, one cancel path — so cancel + progress
// UX is uniform and new ops don't reinvent the plumbing.
// [LAW:one-source-of-truth] Task lifecycle lives here. The renderer observes events;
// it never maintains a parallel registry.
import { webContents } from "electron";
import type { TaskEvent } from "../../shared/types";

export const TASK_EVENT_CHANNEL = "task:event";

export interface TaskMeta {
  // Stable identifier for this class of work. Lets the UI pick labels/icons by kind.
  kind: string;
  // Human-readable label shown in the toast.
  label: string;
  // Expected total work units. Pass 0 if unknown; reportProgress can update it.
  total?: number;
}

// Handle given to the operation. The op calls `throwIfCancelled()` at safe boundaries
// and `reportProgress()` after each unit of work. `signal` is available for libraries
// (e.g. OpenAI SDK) that accept AbortSignal directly.
export interface TaskHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  reportProgress(done: number, total: number, message?: string): void;
  throwIfCancelled(): void;
}

// Marker class so callers can distinguish cancellation from real errors upstream.
export class TaskCancelledError extends Error {
  readonly cancelled = true as const;
  constructor(taskId: string) {
    super(`Task ${taskId} cancelled`);
    this.name = "TaskCancelledError";
  }
}

const controllers = new Map<string, AbortController>();

function broadcast(event: TaskEvent): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    wc.send(TASK_EVENT_CHANNEL, event);
  }
}

// Runs `op` as a tracked task. Renderer supplies the id so it can subscribe to
// progress *before* invoking the IPC that triggers this — closing a classic race
// where the "started" event could fire before the listener attaches.
export async function runTask<T>(
  id: string,
  meta: TaskMeta,
  op: (handle: TaskHandle) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  controllers.set(id, controller);

  const total = meta.total ?? 0;
  broadcast({ type: "started", taskId: id, kind: meta.kind, label: meta.label, total });

  const handle: TaskHandle = {
    id,
    signal: controller.signal,
    reportProgress(done, total, message) {
      broadcast({ type: "progress", taskId: id, done, total, message });
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new TaskCancelledError(id);
    },
  };

  try {
    const result = await op(handle);
    // If cancellation came in on the last await, treat the result as cancelled.
    // Otherwise, done.
    if (controller.signal.aborted) {
      broadcast({ type: "cancelled", taskId: id });
      throw new TaskCancelledError(id);
    }
    broadcast({ type: "done", taskId: id });
    return result;
  } catch (err) {
    if (err instanceof TaskCancelledError || controller.signal.aborted) {
      broadcast({ type: "cancelled", taskId: id });
      throw err instanceof TaskCancelledError ? err : new TaskCancelledError(id);
    }
    broadcast({ type: "error", taskId: id, error: (err as Error).message });
    throw err;
  } finally {
    controllers.delete(id);
  }
}

export function cancelTask(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

// Test hook: clear the registry between tests so state doesn't leak.
export function __resetTasksForTesting(): void {
  controllers.clear();
}
