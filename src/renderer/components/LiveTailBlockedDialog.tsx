import type { SessionSaveResult } from "../../shared/types";

// [LAW:dataflow-not-control-flow] Rendered when SessionSaveResult.
// blockedReason === "live-tail". No state of its own; everything it
// shows comes from props.
//
// The block exists because a running launch is currently appending to
// the file the user just tried to save over. Overwriting that file
// would discard in-flight assistant output. Force save remains the
// escape hatch — the user may want to truncate the file for debugging
// — but it is named "Force save" rather than the encouraging language
// the validation dialog uses, because the cost here is data loss, not
// just a malformed file.
export function LiveTailBlockedDialog({
  onCancel,
  onForceSave,
  saving,
}: {
  result: SessionSaveResult;
  onCancel: () => void;
  onForceSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[36rem] rounded-xl border border-amber-900/60 bg-neutral-900 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-amber-300">
            File is being written by a live launch
          </h2>
          <p className="text-sm text-neutral-400">
            A running Claude launch is appending to this session file. Saving
            now would overwrite assistant output that the tool is still
            producing.
          </p>
        </div>

        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950/50 p-3 text-sm text-neutral-300">
          Stop the launch (or detach to a different file) before saving. Force
          save truncates the file and discards any in-flight output — useful
          only for debugging.
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-neutral-800 pt-4">
          <button
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onForceSave}
            disabled={saving}
            className="rounded-lg bg-amber-900/50 px-4 py-2 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-900/70 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Force save"}
          </button>
        </div>
      </div>
    </div>
  );
}
