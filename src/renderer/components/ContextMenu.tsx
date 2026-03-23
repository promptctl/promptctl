import { useEffect, useCallback } from "react";

export interface ContextMenuItem {
  label: string;
  action: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 min-w-[140px] rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
        style={{ left: x, top: y }}
      >
        {items.map((item, i) => (
          <button
            key={i}
            onClick={() => {
              item.action();
              onClose();
            }}
            className="flex w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
