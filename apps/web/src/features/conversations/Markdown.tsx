import { createRenderer, type MdChild, type MdNode } from "@convoz/markdown";
import { createElement, useMemo, type ReactNode } from "react";

// The renderer builds only these; anything else in a tree is dropped (defence in depth: the tree is ours, never the message's).
// An img comes only from the renderer's own-upload branch (/api/files/<id>, I-45).
const TAGS = new Set(["div", "p", "ul", "li", "pre", "code", "strong", "em", "u", "s", "blockquote", "span", "a", "img"]);
const ATTRS = new Set(["class", "href", "target", "rel", "src", "alt", "loading"]);
const OWN_FILE = /^\/api\/files\/[A-Za-z0-9_-]{22}$/;

let render: ReturnType<typeof createRenderer> | null = null;
/** The renderer, made on first use with the server's lookalike punctuation (/assets/lookalikes.js runs before the app). */
function renderer() {
  const set = (globalThis as { CONVOZ_LOOKALIKES?: unknown }).CONVOZ_LOOKALIKES;
  render ??= createRenderer(typeof set === "string" ? set : null);
  return render;
}

function toReact(node: MdChild, key: number): ReactNode {
  if (typeof node === "string") return node;
  if (!TAGS.has(node.tag)) return null;
  if (node.tag === "img" && !OWN_FILE.test(node.attrs?.src ?? "")) return null;
  const props: Record<string, string | number> = { key };
  for (const [k, v] of Object.entries(node.attrs ?? {})) if (ATTRS.has(k)) props[k === "class" ? "className" : k] = v;
  return createElement(node.tag, props, ...node.kids.map(toReact));
}

/** Markdown shows an agent's markdown body: paragraphs, lists, code, bold, honest links and images of own uploads, nothing else. */
export function Markdown({ text, format = "markdown" }: { text: string; format?: "markdown" | "markdownv2" }) {
  return useMemo(() => toReact(renderer()(text, { format }), 0), [text, format]);
}
