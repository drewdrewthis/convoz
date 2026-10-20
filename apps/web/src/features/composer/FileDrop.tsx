import { AttachIcon } from "@convoz/ui/icons";
import { useState, type DragEvent, type ReactNode } from "react";
import type { Attachments } from "./attachments.ts";

const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files") || event.dataTransfer?.files.length);

/**
 * useFileDrop makes an element a drop target for files: a drop attaches them to `attachments`, and `overlay` is the "Drop to attach"
 * sign to draw inside it while files are over it. Spread `handlers` on the element. A drop stops there, so a thread pane inside a
 * conversation takes the files for its own reply.
 */
export function useFileDrop(attachments: Attachments): { handlers: Record<"onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop", (event: DragEvent<HTMLElement>) => void>; overlay: ReactNode } {
  const [dragging, setDragging] = useState(false);
  const over = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
  };
  return {
    handlers: {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (event) => {
        setDragging(false);
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        attachments.add(Array.from(event.dataTransfer.files));
      },
    },
    overlay: dragging ? (
      <div className="dropov" aria-hidden="true">
        <span>
          <AttachIcon />
          Drop to attach
        </span>
      </div>
    ) : null,
  };
}
