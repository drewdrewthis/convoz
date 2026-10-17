import { useState } from "react";
import type { AppContext, GalleryProps } from "../types.ts";
import { box, muted } from "./tone.ts";

/** Gallery shows uploaded images. Layout compare is a before/after slider over two images. Remote images never load: only upload ids. */
export function Gallery({ props, ctx }: { props: GalleryProps; ctx: AppContext }) {
  const [pos, setPos] = useState(50);
  const imgs = props.images;
  if (props.layout === "compare" && imgs.length === 2) {
    const [a, b] = imgs as [GalleryProps["images"][number], GalleryProps["images"][number]];
    return (
      <div style={box}>
        <div style={{ position: "relative", overflow: "hidden", borderRadius: 8, border: "1px solid var(--color-border)" }}>
          <img src={ctx.fileUrl(a.upload)} alt={a.alt} style={{ display: "block", width: "100%" }} />
          <img src={ctx.fileUrl(b.upload)} alt={b.alt} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", clipPath: `inset(0 0 0 ${pos}%)` }} />
          <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `${pos}%`, width: 2, background: "var(--color-text)" }} />
        </div>
        <label style={{ display: "block", marginTop: 6 }}>
          <span className="sr" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Before and after</span>
          <input type="range" min={0} max={100} value={pos} aria-label="Before and after" aria-valuetext={`Showing ${pos}% before, ${100 - pos}% after`} onChange={(e) => setPos(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, ...muted }}>
          <span>{a.caption ?? "Before"}</span>
          <span>{b.caption ?? "After"}</span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ ...box, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
      {imgs.map((im) => (
        <figure key={im.upload} style={{ margin: 0 }}>
          <img src={ctx.fileUrl(im.upload)} alt={im.alt} style={{ display: "block", width: "100%", borderRadius: 8, border: "1px solid var(--color-border)" }} />
          {im.caption ? <figcaption style={{ fontSize: 12, ...muted }}>{im.caption}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}
