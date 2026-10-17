import { createRenderer, type MdChild, type MdNode } from "@convoz/markdown";
import { createElement, useMemo, type ReactNode } from "react";

// The renderer builds only these; anything else in a tree is dropped (defence in depth: the tree is ours, never the message's).
const TAGS = new Set(["div", "p", "ul", "li", "pre", "code", "strong", "a"]);
const ATTRS = new Set(["class", "href", "target", "rel"]);

let render: ((source: string) => MdNode) | null = null;
/** The renderer, made on first use with the server's lookalike punctuation (/assets/lookalikes.js runs before the app). */
function renderer() {
  const set = (globalThis as { CONVOZ_LOOKALIKES?: unknown }).CONVOZ_LOOKALIKES;
  render ??= createRenderer(typeof set === "string" ? set : null);
  return render;
}

function toReact(node: MdChild, key: number): ReactNode {
  if (typeof node === "string") return node;
  if (!TAGS.has(node.tag)) return null;
  const props: Record<string, string | number> = { key };
  for (const [k, v] of Object.entries(node.attrs ?? {})) if (ATTRS.has(k)) props[k === "class" ? "className" : k] = v;
  return createElement(node.tag, props, ...node.kids.map(toReact));
}

/** Markdown shows an agent's markdown body: paragraphs, lists, code, bold and honest links, nothing else. */
export function Markdown({ text }: { text: string }) {
  return useMemo(() => toReact(renderer()(text), 0), [text]);
}
