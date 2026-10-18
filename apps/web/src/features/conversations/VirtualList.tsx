// The conversation list above VIRTUAL_ABOVE rows (design §12.2): only the rows near the screen are in the page. It is a chunk of its
// own, loaded only for such a list, so the first screen of a short list never downloads the virtualizer.
import type { Conversation } from "@convoz/api-client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState } from "react";
import { Row } from "./Row.tsx";

const ROW_HEIGHT = 64;

export default function VirtualList({ rows, me }: { rows: Conversation[]; me: string }) {
  const list = useRef<HTMLUListElement>(null);
  const [margin, setMargin] = useState(0);
  const scroller = () => list.current?.closest("main") ?? null;
  useLayoutEffect(() => {
    const main = scroller();
    if (main && list.current) setMargin(list.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop);
  }, []);
  const v = useVirtualizer({ count: rows.length, getScrollElement: scroller, estimateSize: () => ROW_HEIGHT, overscan: 8, scrollMargin: margin, getItemKey: (i) => rows[i]!.id });
  return (
    <ul ref={list} id="chat-list" className="chatlist" role="list" aria-label="Conversations" style={{ position: "relative", height: v.getTotalSize() }}>
      {v.getVirtualItems().map((item) => (
        <Row
          key={item.key}
          c={rows[item.index]!}
          me={me}
          index={item.index}
          measure={v.measureElement}
          style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start - margin}px)` }}
        />
      ))}
    </ul>
  );
}

