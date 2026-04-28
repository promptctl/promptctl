// [LAW:dataflow-not-control-flow] The page is a pure projection of the
// connection-state and topology hooks. The same JSX renders for every status
// and pane count; only the values inside the testid spans/rows change. No
// `if (status === "ready")` branches gate elements off the tree —
// assertions can read them deterministically across every transition.

import type { TmuxPane } from "../../shared/types";
import { useControlState, useTopology } from "../tmux/proxy";

export function TmuxControlDebug() {
  const state = useControlState();
  const topology = useTopology();

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

      <section className="flex w-full flex-col gap-2 rounded border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-mono text-xs uppercase tracking-wide text-neutral-400">
            panes
          </h2>
          <span
            data-testid="topology-pane-count"
            className="font-mono text-xs text-neutral-500"
          >
            {topology.panes.length}
          </span>
        </div>
        <PaneTable panes={topology.panes} />
      </section>
    </div>
  );
}

function PaneTable({ panes }: { panes: readonly TmuxPane[] }) {
  return (
    <div
      data-testid="topology-pane-table"
      className="grid grid-cols-[8rem_8rem_8rem_4rem_1fr_6rem] gap-x-3 gap-y-1 font-mono text-xs"
    >
      <HeaderCell>pane</HeaderCell>
      <HeaderCell>session</HeaderCell>
      <HeaderCell>window</HeaderCell>
      <HeaderCell>pid</HeaderCell>
      <HeaderCell>cmd · cwd</HeaderCell>
      <HeaderCell>size</HeaderCell>
      {panes.map((pane) => (
        <PaneRow key={pane.id} pane={pane} />
      ))}
    </div>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return <span className="text-neutral-500">{children}</span>;
}

function PaneRow({ pane }: { pane: TmuxPane }) {
  // Identity cell uses data-pane-row (a distinct attribute) so e2e tests
  // count rows with `[data-pane-row]` without colliding with the per-cell
  // testids below. The testid still embeds the raw pane id (e.g. `%17`)
  // for direct selection.
  const idTestId = `pane-row-${pane.id}`;
  return (
    <>
      <span
        data-pane-row={pane.id}
        data-testid={idTestId}
        className="text-cyan-300"
      >
        {pane.id}
        {pane.active ? " *" : ""}
      </span>
      <span data-testid={`${idTestId}-session`} className="text-neutral-300">
        {pane.sessionName}
      </span>
      <span data-testid={`${idTestId}-window`} className="text-neutral-300">
        {pane.windowName}
      </span>
      <span data-testid={`${idTestId}-pid`} className="text-neutral-400">
        {pane.pid}
      </span>
      <span
        data-testid={`${idTestId}-cmd`}
        className="truncate text-neutral-200"
        title={pane.currentPath}
      >
        <span className="text-amber-300">{pane.currentCommand || "—"}</span>
        <span className="text-neutral-500"> · {pane.currentPath || "—"}</span>
      </span>
      <span data-testid={`${idTestId}-size`} className="text-neutral-500">
        {pane.width}×{pane.height}
      </span>
    </>
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
