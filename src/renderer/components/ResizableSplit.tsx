// [LAW:single-enforcer] One pane-resize component for the entire renderer.
// Every split uses the same drag math, the same handle, the same min/max
// clamping. Adding a second resizer would invite drift.
// [LAW:dataflow-not-control-flow] Each instance feeds its constraints
// (orientation, side, defaults) as data; the same render path runs every
// frame regardless of whether a drag is in progress.
import { useCallback, useRef, useState, type ReactNode } from "react";

export type SplitOrientation = "horizontal" | "vertical";
export type SplitSide = "before" | "after";

interface ResizableSplitProps {
  orientation: SplitOrientation;
  side: SplitSide;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  className?: string;
  testId?: string;
  children: [ReactNode, ReactNode];
}

export function ResizableSplit({
  orientation,
  side,
  defaultSize,
  minSize,
  maxSize,
  className,
  testId,
  children,
}: ResizableSplitProps) {
  const [size, setSize] = useState(() => clamp(defaultSize, minSize, maxSize));
  const dragRef = useRef<{ startPos: number; startSize: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startPos: orientation === "horizontal" ? e.clientX : e.clientY,
        startSize: size,
      };
    },
    [orientation, size],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const pos = orientation === "horizontal" ? e.clientX : e.clientY;
      const direction = side === "before" ? 1 : -1;
      const next = clamp(
        drag.startSize + direction * (pos - drag.startPos),
        minSize,
        maxSize,
      );
      setSize(next);
    },
    [orientation, side, minSize, maxSize],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [],
  );

  const isHorizontal = orientation === "horizontal";
  const sizedStyle = isHorizontal
    ? { width: `${size}px` }
    : { height: `${size}px` };
  const beforeIsSized = side === "before";

  // [LAW:dataflow-not-control-flow] DOM order is fixed (children[0] then [1]);
  // `side` decides which slot owns the explicit size, the other gets flex-1.
  return (
    <div
      data-testid={testId}
      data-orientation={orientation}
      className={`flex min-h-0 min-w-0 ${
        isHorizontal ? "flex-row" : "flex-col"
      } ${className ?? ""}`}
    >
      <div
        data-testid={testId ? `${testId}-first` : undefined}
        style={beforeIsSized ? sizedStyle : undefined}
        className={
          beforeIsSized
            ? "flex min-h-0 min-w-0 shrink-0 flex-col"
            : "flex min-h-0 min-w-0 flex-1 flex-col"
        }
      >
        {children[0]}
      </div>
      <SplitHandle
        orientation={orientation}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        data-testid={testId ? `${testId}-second` : undefined}
        style={!beforeIsSized ? sizedStyle : undefined}
        className={
          beforeIsSized
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : "flex min-h-0 min-w-0 shrink-0 flex-col"
        }
      >
        {children[1]}
      </div>
    </div>
  );
}

function SplitHandle({
  orientation,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  orientation: SplitOrientation;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const isHorizontal = orientation === "horizontal";
  return (
    <div
      data-testid="split-handle"
      data-orientation={orientation}
      role="separator"
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`shrink-0 bg-transparent transition-colors hover:bg-cyan-500/40 ${
        isHorizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
      }`}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
