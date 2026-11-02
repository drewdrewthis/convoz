import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "./cx.ts";

export interface ResizeHandleProps {
  /** What the handle resizes, said to a screen reader: "Resize sidebar". */
  label: string;
  /** The current size in px, and the least and most it may take. */
  value: number;
  min: number;
  max: number;
  /** Px per arrow press. */
  step?: number;
  /** Asked for a new size on every drag move and arrow press; the caller clamps and keeps it. */
  onChange(next: number): void;
  /** A double click: back to the first size. */
  onReset(): void;
  className?: string;
}

/**
 * ResizeHandle is a vertical splitter on the edge of a panel, where the caller places it with `className` (a few px wide, straddling the edge). Drag it, or focus it and press
 * Left or Right. It grows the panel when moved right, so it is for a panel on the left of the page.
 */
export function ResizeHandle({ label, value, min, max, step = 16, onChange, onReset, className }: ResizeHandleProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, value };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(start.current.value + e.clientX - start.current.x);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!by) return;
    e.preventDefault();
    onChange(value + by);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onKeyDown={key}
      onDoubleClick={onReset}
      className={cx("cursor-col-resize touch-none bg-transparent hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none", className)}
    />
  );
}
