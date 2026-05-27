// Workshop's launch-detail view. Three side-by-side panels driven
// entirely off the same launch row:
//   - Pane terminal (paneId → live xterm stream)
//   - Live request stream (proxyClientId → filtered request list)
//   - Session file (sessionFilePath → path + Open-in-Context-Workshop)
//
// [LAW:types-are-the-program] Each panel is a one-liner projection
// off the launch row's fields. The detail view never asks "is this
// launch the primary one" — it asks "what does this row carry"
// and renders accordingly.
//
// [LAW:dataflow-not-control-flow] The same component renders every
// launch. Field presence (paneId, sessionFilePath, status) decides
// what's interactive; the components do not branch on launch
// identity, tool kind, or "is this the main one."
//
// [LAW:one-source-of-truth] Topology, proxy events, and the launch
// row each come from their own canonical store. The detail view
// composes the three projections without holding any cache of its
// own.

import { PaneTerminal } from "@promptctl/pane-terminal/react";
import "@xterm/xterm/css/xterm.css";
import { useNavigate } from "react-router";
import { useMemo, useState } from "react";
import type { Launch, LaunchId, ToolKind } from "../../shared/types";
import { useLaunchStore } from "../store/launches";
import { useTopology, usePaneStream } from "../tmux/proxy";
import { useProxyStore } from "../store/proxy";
import { usePaneSelectionStore } from "../store/pane-selection";

const TOOL_COLORS: Record<ToolKind, string> = {
  claude: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  codex: "bg-green-500/10 text-green-400 border-green-500/20",
  gemini: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  unknown: "bg-neutral-500/10 text-neutral-400 border-neutral-500/20",
};

const STATUS_COLORS: Record<Launch["status"], string> = {
  pending: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  running: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  exited: "bg-neutral-700/40 text-neutral-400 border-neutral-700/40",
};

export function WorkshopLaunchDetail({ launchId }: { launchId: LaunchId }) {
  const launch = useLaunchStore((s) => s.byId(launchId));
  const navigate = useNavigate();

  if (launch === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500">
        <div className="text-center">
          <p className="mb-2 text-neutral-400">Launch not found.</p>
          <p className="text-xs">
            The launch id{" "}
            <span className="font-mono text-neutral-300">{launchId}</span> is
            not in the registry.
          </p>
          <button
            type="button"
            onClick={() => navigate("/workshop")}
            className="mt-3 rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            ← Back to launches
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <Header launch={launch} onBack={() => navigate("/workshop")} />
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="col-span-1 flex min-h-0 flex-col gap-2">
          <SectionTitle>Pane terminal</SectionTitle>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-neutral-900">
            <PaneTerminalPanel launch={launch} />
          </div>
        </div>
        <div className="col-span-1 flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <SectionTitle>Live requests</SectionTitle>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/40 font-mono text-xs">
              <RequestsPanel launch={launch} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <SectionTitle>Session file</SectionTitle>
            <SessionFilePanel launch={launch} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({
  launch,
  onBack,
}: {
  readonly launch: Launch;
  readonly onBack: () => void;
}) {
  const [terminating, setTerminating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // [LAW:dataflow-not-control-flow] The terminate affordance is driven
  // by status. Exited rows hide the button because the data carries no
  // session to kill; no branch on "is this the active launch."
  const canTerminate = launch.status !== "exited";

  const terminate = async () => {
    setError(null);
    setTerminating(true);
    try {
      await window.electronAPI.invoke("launch:terminate", launch.launchId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTerminating(false);
    }
  };

  const openInLoops = () => {
    usePaneSelectionStore.getState().selectPane(launch.paneId);
    navigate("/loops");
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800 pb-3">
      <button
        type="button"
        onClick={onBack}
        className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
      >
        ← Launches
      </button>
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TOOL_COLORS[launch.toolKind]}`}
      >
        {launch.toolKind}
      </span>
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_COLORS[launch.status]}`}
      >
        {launch.status}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm text-neutral-200" title={launch.cwd}>
          {launch.cwd}
        </p>
        <p
          className="truncate font-mono text-[10px] text-neutral-500"
          title={launch.launchId}
        >
          launch {launch.launchId}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {/* [LAW:dataflow-not-control-flow] Both affordances are gated
            on the same status discriminator: an exited row's pane is
            expected to be gone (the correlator's pane/window-close
            path is what flipped the row exited in the first place),
            so pointing Loops at it would land on the "Select a pane"
            placeholder — a dead-end UX. The button hides whenever the
            row's data says the pane isn't actionable. */}
        {canTerminate && (
          <button
            type="button"
            data-testid="workshop-open-in-loops"
            onClick={openInLoops}
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            Open pane in Loops
          </button>
        )}
        {canTerminate && (
          <button
            type="button"
            data-testid="workshop-terminate"
            onClick={terminate}
            disabled={terminating}
            className="rounded bg-red-900/40 px-2 py-1 text-xs text-red-200 transition-colors hover:bg-red-900/60 disabled:opacity-40"
          >
            {terminating ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {error !== null && (
        <p className="w-full text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
    </p>
  );
}

function PaneTerminalPanel({ launch }: { launch: Launch }) {
  const topology = useTopology();
  // Match by paneId — the row owns the pane regardless of status.
  // An exited launch's pane may already be gone from topology; the
  // useTopology projection drops the stream when there's no pane,
  // and the panel renders the placeholder. [LAW:dataflow-not-control-flow]
  const pane = useMemo(
    () => topology.panes.find((p) => p.id === launch.paneId) ?? null,
    [topology.panes, launch.paneId],
  );
  const stream = usePaneStream(pane);

  if (pane === null) {
    return (
      <div
        data-testid="workshop-pane-missing"
        className="flex h-full items-center justify-center text-xs text-neutral-500"
      >
        Pane{" "}
        <span className="ml-1 font-mono text-neutral-300">{launch.paneId}</span>{" "}
        is not present in the topology.
      </div>
    );
  }
  return (
    <div
      data-testid="workshop-pane-terminal"
      data-pane-id={pane.id}
      className="h-full"
    >
      {stream !== null && (
        <PaneTerminal stream={stream} className="h-full w-full" autoFocus />
      )}
    </div>
  );
}

function RequestsPanel({ launch }: { launch: Launch }) {
  const requests = useProxyStore((s) => s.requests);
  const clients = useProxyStore((s) => s.clients);
  // [LAW:one-source-of-truth] The proxy assigns each client a stable
  // launchId from the X-Promptctl-Launch header. The Workshop detail
  // view collects every clientId whose launchId matches this launch
  // and projects the request list from those clients only. No fallback
  // to "all unrouted traffic", no merging across launches — the data
  // carries the answer.
  const matched = useMemo(() => {
    const clientIds = new Set<string>();
    for (const [id, info] of clients) {
      if (info.launchId === launch.launchId) clientIds.add(id);
    }
    return [...requests.values()]
      .filter((r) => clientIds.has(r.clientId))
      .sort((a, b) => a.startedNs - b.startedNs);
  }, [requests, clients, launch.launchId]);

  const navigate = useNavigate();

  if (matched.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-neutral-500">
        <p>
          No requests attributed to this launch yet.
          <br />
          Header attribution requires the proxy to receive at least one
          request from the tool.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="workshop-requests-list">
      {matched.map((r) => (
        <button
          key={r.requestId}
          type="button"
          data-testid="workshop-request-row"
          data-request-id={r.requestId}
          onClick={() => {
            useProxyStore.getState().selectClient(r.clientId);
            useProxyStore.getState().toggleRequest(r.requestId);
            navigate("/live");
          }}
          className="flex w-full items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-left hover:bg-neutral-900"
        >
          <span className="text-blue-400">{r.method || "?"}</span>
          <span className="text-neutral-500">{r.status ?? r.state}</span>
          <span className="min-w-0 flex-1 truncate text-neutral-300">
            {r.url || "(unknown)"}
          </span>
        </button>
      ))}
    </div>
  );
}

function SessionFilePanel({ launch }: { launch: Launch }) {
  const navigate = useNavigate();
  // sessionFilePath only exists on running/exited rows (the type
  // narrows by status). For pending, the field doesn't exist — show
  // the waiting state. [LAW:types-are-the-program]
  const path =
    launch.status === "running" || launch.status === "exited"
      ? launch.sessionFilePath
      : null;

  if (launch.status === "pending") {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
        Waiting for the launch to enter the running state.
      </div>
    );
  }
  if (path === null) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
        No session file has appeared under this project yet — the tool may
        not have written its first message.
      </div>
    );
  }
  return (
    <div
      data-testid="workshop-session-file"
      data-session-file-path={path}
      className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-3"
    >
      <p
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-300"
        title={path}
      >
        {path}
      </p>
      <button
        type="button"
        data-testid="workshop-open-session"
        onClick={() => navigate("/context-workshop")}
        className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
        title="Jump to the Context Workshop tab. The Live Launches sidebar group shows this launch's session for one-click adoption."
      >
        Open in Context Workshop
      </button>
    </div>
  );
}
