// [LAW:dataflow-not-control-flow] The page is a pure projection of the
// connection-state hook. The same JSX renders for every status; only the
// values inside the testid spans change. No `if (status === "ready")` branches
// gate elements off the tree — assertions can read them deterministically
// across every transition.

import { useControlState } from "../tmux/proxy";

export function TmuxControlDebug() {
  const state = useControlState();

  return (
    <div className="flex h-full flex-col gap-4 bg-neutral-950 p-6 text-sm text-neutral-200">
      <header>
        <h1 className="text-base font-semibold tracking-tight text-neutral-100">
          tmux control connection — debug
        </h1>
        <p className="mt-1 text-xs text-neutral-500">
          Live state of the singleton <code>TmuxControlConnection</code> in main.
          This panel is the verification surface for every tmux-integration
          slice — values update on every state transition without a refresh.
        </p>
      </header>

      <section className="grid w-full max-w-md grid-cols-[10rem_1fr] gap-y-2 rounded border border-neutral-800 bg-neutral-900 p-4 font-mono text-xs">
        <span className="text-neutral-500">status</span>
        <span
          data-testid="control-status"
          className={statusClass(state.status)}
        >
          {state.status}
        </span>

        <span className="text-neutral-500">reason</span>
        <span data-testid="control-reason" className="text-neutral-300">
          {state.reason ?? "—"}
        </span>

        <span className="text-neutral-500">reconnect attempts</span>
        <span
          data-testid="control-reconnect-attempts"
          className="text-neutral-300"
        >
          {state.reconnectAttempts}
        </span>
      </section>
    </div>
  );
}

function statusClass(status: "connecting" | "ready" | "closed"): string {
  // [LAW:single-enforcer] Status → color mapping is a static table; no inline
  // branches scattered across the component.
  return STATUS_CLASSES[status];
}

const STATUS_CLASSES: Record<"connecting" | "ready" | "closed", string> = {
  connecting: "text-amber-400",
  ready: "text-green-400",
  closed: "text-red-400",
};
