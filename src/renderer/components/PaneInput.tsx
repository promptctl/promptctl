import { useState, useCallback, type KeyboardEvent } from "react";
import type { PaneId } from "../../shared/types";

export function PaneInput({ paneId }: { paneId: PaneId }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    const text = value.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      await window.electronAPI.invoke("tmux:send-keys", paneId, text, true);
      setValue("");
    } finally {
      setSending(false);
    }
  }, [value, paneId, sending]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Send command..."
        className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-neutral-500"
        disabled={sending}
      />
      <button
        onClick={send}
        disabled={sending || !value.trim()}
        className="rounded-lg bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-600 disabled:opacity-40"
      >
        Send
      </button>
    </div>
  );
}
