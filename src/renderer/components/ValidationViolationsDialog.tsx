import type { SessionSaveResult } from "../../shared/types";

// Pre-save validation blocked a save. The renderer shows this dialog listing
// every violation so the user can either adjust their selection or force save
// anyway (escape hatch for debugging). [LAW:dataflow-not-control-flow] Rendered
// from result.violations; the invariantId is the only provider-specific datum
// and it's user-readable.
export function ValidationViolationsDialog({
  result,
  onCancel,
  onForceSave,
  saving,
}: {
  result: SessionSaveResult;
  onCancel: () => void;
  onForceSave: () => void;
  saving: boolean;
}) {
  const total = result.violations.reduce((n, v) => n + v.offenders.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="max-h-[80vh] w-[42rem] overflow-auto rounded-xl border border-red-900/50 bg-neutral-900 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-red-300">
            Save would produce a structurally broken session
          </h2>
          <p className="text-sm text-neutral-400">
            The Anthropic API will likely reject this session on resume. {total}{" "}
            structural violation{total === 1 ? "" : "s"} across{" "}
            {result.violations.length} rule
            {result.violations.length === 1 ? "" : "s"}.
          </p>
        </div>

        <div className="mt-4 space-y-4">
          {result.violations.map((v) => (
            <div
              key={v.invariantId}
              className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3"
            >
              <div className="flex items-center justify-between">
                <code className="text-xs text-neutral-400">
                  {v.invariantId}
                </code>
                <span className="text-xs text-neutral-500">
                  {v.offenders.length} offender
                  {v.offenders.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-200">{v.summary}</p>
              <ul className="mt-2 space-y-1">
                {v.offenders.slice(0, 8).map((o, i) => (
                  <li
                    key={i}
                    className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
                  >
                    <div className="text-neutral-400">
                      line {o.lineIndex}
                      {o.uuid ? ` · uuid=${o.uuid.slice(0, 8)}` : ""}
                    </div>
                    <div>{o.detail}</div>
                    {o.preview && (
                      <div className="mt-1 truncate italic text-neutral-500">
                        &quot;{o.preview}&quot;
                      </div>
                    )}
                  </li>
                ))}
                {v.offenders.length > 8 && (
                  <li className="px-2 text-xs text-neutral-500">
                    … {v.offenders.length - 8} more
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-neutral-800 pt-4">
          <p className="text-xs text-neutral-500">
            Force save writes the file anyway — useful only if you want to
            inspect the broken state.
          </p>
          <div className="flex gap-2">
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
              className="rounded-lg bg-red-900/50 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-900/70 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Force save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
