// Workshop's active-launches list. Renders every launch with the same
// row component — no per-launch privilege, no "main" or "primary".
//
// [LAW:dataflow-not-control-flow] Variability lives in the row data
// (toolKind, status, cwd, sessionFilePath). The component path is
// identical for every row; status decides which affordances data
// allows, not which component renders.
//
// [LAW:one-type-per-behavior] Every Launch row is a Launch row.
// `status` narrows the optional fields the type carries, and the
// row's affordances key off the discriminator — but no row escapes
// the uniform shape.
//
// [LAW:one-source-of-truth] The list reads useLaunchStore directly.
// Sort order is derived (running first, then pending, then exited;
// each bucket newest-first). No parallel cache, no shadow ordering
// kept outside the store's `launches` array.

import { useMemo } from "react";
import { useNavigate } from "react-router";
import type { Launch, LaunchId, ToolKind } from "../../shared/types";
import { useLaunchStore } from "../store/launches";

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

// Sort key keeps the type narrow: lower is earlier in the list.
// Running launches dominate (the active surface); pending precede
// exited (the historical surface). Within each bucket, newest first.
function statusRank(status: Launch["status"]): number {
  if (status === "running") return 0;
  if (status === "pending") return 1;
  return 2;
}

export function WorkshopLaunchList({
  onNewLaunch,
}: {
  readonly onNewLaunch: () => void;
}) {
  const launches = useLaunchStore((s) => s.launches);
  const sorted = useMemo(() => {
    return [...launches].sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      return b.startedAt - a.startedAt;
    });
  }, [launches]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-100">
            Workshop
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Spawn tagged tool launches and inspect them across pane, requests,
            and session file in one view.
          </p>
        </div>
        <button
          type="button"
          data-testid="workshop-new-launch"
          onClick={onNewLaunch}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500"
        >
          New launch
        </button>
      </div>

      {sorted.length === 0 ? (
        <EmptyHint />
      ) : (
        <div
          data-testid="workshop-launches-list"
          className="min-h-0 flex-1 space-y-2 overflow-y-auto"
        >
          {sorted.map((launch) => (
            <WorkshopLaunchRow key={launch.launchId} launch={launch} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkshopLaunchRow({ launch }: { launch: Launch }) {
  const navigate = useNavigate();
  const open = () => navigate(`/workshop?launchId=${launch.launchId}`);
  // sessionFilePath lives only on running / exited rows; the type
  // carries the optionality, the renderer just reads it.
  const sessionFilePath =
    launch.status === "running" || launch.status === "exited"
      ? launch.sessionFilePath
      : null;
  return (
    <div
      data-testid="workshop-launch-row"
      data-launch-id={launch.launchId}
      data-launch-status={launch.status}
      data-launch-tool={launch.toolKind}
      className="cursor-pointer rounded-md border border-neutral-800 bg-neutral-900/40 p-3 transition-colors hover:bg-neutral-900"
      onClick={open}
    >
      <div className="flex items-center gap-3">
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${TOOL_COLORS[launch.toolKind]}`}
        >
          {launch.toolKind}
        </span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_COLORS[launch.status]}`}
        >
          {launch.status}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm text-neutral-200"
            title={launch.cwd}
          >
            {basename(launch.cwd)}
          </p>
          <p className="truncate text-xs text-neutral-500">{launch.cwd}</p>
        </div>
        <div className="shrink-0 text-right font-mono text-[10px] text-neutral-500">
          <div>launch {String(launch.launchId).slice(0, 8)}</div>
          <div>{relativeTime(launch.startedAt)}</div>
        </div>
      </div>
      {sessionFilePath !== null && (
        <p
          data-testid="workshop-launch-row-session-path"
          className="mt-2 truncate font-mono text-[10px] text-neutral-600"
          title={sessionFilePath}
        >
          {sessionFilePath}
        </p>
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-neutral-800 text-sm text-neutral-500">
      <div className="text-center">
        <p className="mb-1 text-neutral-400">No launches yet.</p>
        <p className="text-xs">
          Click <span className="text-neutral-300">New launch</span> to spawn a
          tagged tool. It will appear here, in Loops as a pane, and in Live
          attributed by header.
        </p>
      </div>
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return p;
  return p.slice(i + 1) || p;
}

function relativeTime(epochMs: number): string {
  const ms = Date.now() - epochMs;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function launchDetailRoute(launchId: LaunchId): string {
  return `/workshop?launchId=${launchId}`;
}
