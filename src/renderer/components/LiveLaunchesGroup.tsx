// "Live launches" group rendered at the top of the Sessions sidebar.
// Reads the launch store, filters to running Claude launches, and
// projects each one as an Adopt row.
//
// [LAW:dataflow-not-control-flow] The component is a pure projection
// of useLaunchStore: same code path for every row, the variability is
// which launches the store contains and whether each carries a
// sessionFilePath yet. No "is this the primary launch" branches; no
// "is the user attached" branches. Each row's affordance is dictated
// by its row data.
//
// [LAW:one-type-per-behavior] Every row uses the same component. The
// presence of sessionFilePath toggles the affordance (Adopt button vs
// waiting placeholder) — it does not produce a different row type.

import { useMemo } from "react";
import type { LaunchRunning } from "../../shared/types";
import { useLaunchStore } from "../store/launches";

export interface LiveLaunchesGroupProps {
  // Active session's file path. When a running launch's
  // sessionFilePath matches this, the row is highlighted as the
  // currently-adopted file. Plumbed in by the editor's main view; the
  // group doesn't read selectedSession itself to keep its API narrow
  // and testable.
  readonly activeFilePath: string | null;
  // Invoked when the user clicks "Adopt" on a launch row with a
  // resolved sessionFilePath. The editor opens the file in place of
  // whatever was selected.
  readonly onAdopt: (launch: LaunchRunning, sessionFilePath: string) => void;
}

export function LiveLaunchesGroup({
  activeFilePath,
  onAdopt,
}: LiveLaunchesGroupProps) {
  // Selector returns the array reference — the store updates the
  // reference on every push, so React re-renders correctly. Filter to
  // claude/running here (cheap; the list is small) instead of caching
  // a derived selector — easier to reason about, no stale memoization.
  const launches = useLaunchStore((s) => s.launches);
  const live = useMemo(
    () =>
      launches.filter(
        (l): l is LaunchRunning =>
          l.toolKind === "claude" && l.status === "running",
      ),
    [launches],
  );

  if (live.length === 0) return null;

  return (
    <div className="mb-3 rounded-md border border-amber-900/40 bg-amber-950/10 p-2">
      <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-amber-400/80">
        Live launches
      </p>
      <div className="space-y-1">
        {live.map((launch) => (
          <LaunchRow
            key={launch.launchId}
            launch={launch}
            isActive={
              launch.sessionFilePath !== null &&
              launch.sessionFilePath === activeFilePath
            }
            onAdopt={onAdopt}
          />
        ))}
      </div>
    </div>
  );
}

function LaunchRow({
  launch,
  isActive,
  onAdopt,
}: {
  launch: LaunchRunning;
  isActive: boolean;
  onAdopt: (launch: LaunchRunning, sessionFilePath: string) => void;
}) {
  const sessionFilePath = launch.sessionFilePath;
  return (
    <div
      data-testid="live-launch-row"
      data-launch-id={launch.launchId}
      className={`rounded px-2 py-1.5 text-sm ${
        isActive
          ? "bg-amber-900/20 ring-1 ring-amber-700/40"
          : "hover:bg-neutral-800/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-neutral-200">
            {basename(launch.cwd)}
            <span className="ml-2 text-xs text-neutral-500">claude</span>
          </p>
          <p className="truncate text-xs text-neutral-500">{launch.cwd}</p>
        </div>
        {sessionFilePath !== null ? (
          isActive ? (
            <span className="shrink-0 rounded bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-100">
              Adopted
            </span>
          ) : (
            <button
              onClick={() => onAdopt(launch, sessionFilePath)}
              className="shrink-0 rounded bg-amber-900/30 px-2 py-1 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-900/50"
            >
              Adopt
            </button>
          )
        ) : (
          <span
            className="shrink-0 text-xs italic text-neutral-500"
            title="No .jsonl file has appeared under this project yet — the launch is starting up."
          >
            waiting…
          </span>
        )}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return p;
  return p.slice(i + 1) || p;
}
