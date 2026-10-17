// Drag to reorder (prototype v41 railPointerDown .. dragEnd). Nothing starts until the pointer has moved 4px, so a click still opens
// the row. The motion is transforms on the DOM and the order is written once, on the drop; Escape puts everything back.
import type { PointerEvent as ReactPointerEvent } from "react";

interface Item {
  el: HTMLElement;
  id: number;
  grp: string;
  top: number;
  left: number;
  w: number;
  h: number;
  mid: number;
}

interface Drag {
  id: number;
  row: HTMLElement;
  x: number;
  y: number;
  on: boolean;
  items: Item[];
  i: number;
  step: number;
  k: number;
  grp: string;
  before: number | null;
  hdrMid: number | null;
  line: HTMLElement | null;
  scroll: HTMLElement | null;
  srTop: number;
  top0: number;
  background: string;
}

/** Where a row was dropped: the group, and the row it now sits directly below in that group (null: first). */
export interface Drop {
  id: number;
  starred: boolean;
  after: number | null;
}

let drag: Drag | null = null;

/** startDrag is the pointerdown of a row. `onDrop` runs once, on a release that moved the row. */
export function startDrag(e: ReactPointerEvent<HTMLElement>, onDrop: (d: Drop) => void): void {
  if (e.button || drag) return;
  if ((e.target as HTMLElement).closest(".rstar")) return;
  const row = e.currentTarget.closest<HTMLElement>("[data-rid]");
  if (!row) return;
  drag = { id: Number(row.dataset.rid), row, x: e.clientX, y: e.clientY, on: false, items: [], i: -1, step: 0, k: 0, grp: "", before: null, hdrMid: null, line: null, scroll: null, srTop: 0, top0: 0, background: "" };
  const move = (ev: PointerEvent) => {
    const d = drag;
    if (!d) return;
    if (!d.on) {
      if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 4) return;
      if (!begin(d)) return end(true, onDrop);
    }
    ev.preventDefault();
    update(d, ev.clientY);
  };
  const up = () => end(false, onDrop);
  const cancel = () => end(true, onDrop);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && drag?.on) {
      ev.preventDefault();
      ev.stopPropagation();
      end(true, onDrop);
    }
  };
  stop = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", key, true);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", key, true);
}

let stop: () => void = () => {};

function begin(d: Drag): boolean {
  const els = [...document.querySelectorAll<HTMLElement>("[data-rid]")].filter((el) => el.offsetParent !== null);
  const scroll = d.row.closest<HTMLElement>("[data-rscroll]");
  if (!scroll || !els.length) return false;
  const sr = scroll.getBoundingClientRect();
  d.scroll = scroll;
  d.srTop = sr.top;
  d.top0 = scroll.scrollTop;
  d.items = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, id: Number(el.dataset.rid), grp: el.dataset.grp ?? "", top: r.top, left: r.left, w: r.width, h: r.height, mid: r.top + r.height / 2 };
  });
  d.i = d.items.findIndex((r) => r.el === d.row);
  if (d.i < 0) return false;
  let gap = 0;
  for (let n = 1; n < d.items.length; n++) {
    if (d.items[n]!.grp === d.items[n - 1]!.grp) {
      gap = d.items[n]!.top - d.items[n - 1]!.top - d.items[n - 1]!.h;
      break;
    }
  }
  d.step = d.items[d.i]!.h + gap;
  const header = document.querySelector("[data-ghdr='mid']");
  const hr = header?.getBoundingClientRect();
  d.hdrMid = hr ? hr.top + hr.height / 2 : null;
  const line = document.createElement("div");
  line.setAttribute("aria-hidden", "true");
  line.className = "dropline";
  line.style.cssText = `left:${d.items[0]!.left - sr.left}px;width:${d.items[0]!.w}px`;
  scroll.appendChild(line);
  d.line = line;
  d.background = d.row.style.background;
  d.row.classList.add("dragging");
  for (const [n, r] of d.items.entries()) if (n !== d.i) r.el.style.transition = "transform 140ms cubic-bezier(.2,.8,.2,1)";
  document.body.style.userSelect = "none";
  d.on = true;
  return true;
}

function update(d: Drag, cy: number): void {
  const dy = cy - d.y;
  const me = d.items[d.i]!;
  const cm = me.mid + dy;
  d.row.style.transform = `translateY(${dy}px)`;
  const others = d.items.filter((_, i) => i !== d.i);
  const k = others.filter((r) => r.mid < cm).length;
  const a = k > 0 ? others[k - 1] : undefined;
  const b = k < others.length ? others[k] : undefined;
  let grp: string;
  if (!a && !b) grp = me.grp;
  else if (!a) grp = b!.grp;
  else if (!b) grp = a.grp;
  else grp = a.grp === b.grp ? a.grp : d.hdrMid !== null && cm < d.hdrMid ? a.grp : b.grp;
  d.k = k;
  d.grp = grp;
  d.before = b ? b.id : null;
  for (const [i, r] of d.items.entries()) {
    if (i === d.i) continue;
    const oi = i < d.i ? i : i - 1;
    let shift = 0;
    if (i < d.i && oi >= k) shift = d.step;
    else if (i > d.i && oi < k) shift = -d.step;
    r.el.style.transform = shift ? `translateY(${shift}px)` : "";
  }
  const y = a && a.grp === grp ? a.top + a.h : b ? b.top : a ? a.top + a.h : me.top;
  if (d.line) {
    d.line.style.top = `${y - d.srTop + d.top0 - 1}px`;
    d.line.style.display = "block";
  }
}

function end(cancel: boolean, onDrop: (d: Drop) => void): void {
  const d = drag;
  drag = null;
  stop();
  if (!d || !d.on) return;
  for (const r of d.items) {
    r.el.style.transform = "";
    r.el.style.transition = "";
  }
  d.row.classList.remove("dragging");
  d.row.style.background = d.background;
  d.line?.remove();
  document.body.style.userSelect = "";
  // The release lands on the row; keep it from also opening the conversation.
  const swallow = (ev: Event) => (ev.stopPropagation(), ev.preventDefault());
  document.addEventListener("click", swallow, true);
  setTimeout(() => document.removeEventListener("click", swallow, true), 60);
  if (cancel || !d.grp) return;
  const me = d.items[d.i]!;
  if (d.k === d.i && d.grp === me.grp) return;
  const starred = d.grp === "starred";
  const into = d.items.filter((r) => r.id !== d.id && r.grp === d.grp).map((r) => r.id);
  const at = d.before === null ? -1 : into.indexOf(d.before);
  onDrop({ id: d.id, starred, after: at < 0 ? (into.at(-1) ?? null) : at > 0 ? into[at - 1]! : null });
}
