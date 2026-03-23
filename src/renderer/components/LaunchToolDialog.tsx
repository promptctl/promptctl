import { useState } from "react";
import type { ToolKind } from "../../shared/types";

const TOOLS: { kind: Exclude<ToolKind, "unknown">; label: string }[] = [
  { kind: "claude", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "gemini", label: "Gemini CLI" },
];

export function LaunchToolDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Exclude<ToolKind, "unknown">>("claude");
  const [sessionName, setSessionName] = useState("");
  const [cwd, setCwd] = useState("/");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    if (!sessionName.trim()) return;
    setLaunching(true);
    setError(null);
    try {
      await window.electronAPI.invoke(
        "tmux:launch-tool",
        kind,
        sessionName.trim(),
        cwd,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 space-y-4 rounded-xl border border-neutral-700 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-neutral-100">Launch Tool</h2>

        <div className="space-y-3">
          <div className="flex gap-2">
            {TOOLS.map((tool) => (
              <button
                key={tool.kind}
                onClick={() => setKind(tool.kind)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  kind === tool.kind
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                {tool.label}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="Session name"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
          />

          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="Working directory"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
          />

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={launch}
            disabled={launching || !sessionName.trim()}
            className="rounded-lg bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-600 disabled:opacity-40"
          >
            {launching ? "Launching..." : "Launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
