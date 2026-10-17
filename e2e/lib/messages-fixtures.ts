import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./run.ts";

/** The shared fixtures of the contract package: the server (Go) and the web app (TS) are both held to them. */
const fixtures = path.join(repoRoot, "packages", "contracts", "fixtures");

export interface ProjectionCase {
  name: string;
  message: Record<string, unknown>;
  short: string;
  long: string;
}

export interface MentionCase {
  name: string;
  format: "markdown" | "markdownv2" | "plain";
  body: string;
  mentions: string[];
}

const read = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(fixtures, ...parts), "utf8")) as T;

/** One message of each of the 10 variants, plus a reply, a broadcast, an edit and an unfurl (AC-M1). */
export const projectionFixtures = (): ProjectionCase[] => [...read<ProjectionCase[]>("projection", "variants.json"), ...read<ProjectionCase[]>("projection", "text.json")];

export const mentionFixtures = (): MentionCase[] => read<MentionCase[]>("mentions", "cases.json");

/** A small deterministic generator (mulberry32), so a failing body can be found again from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The pieces of the fuzzed bodies: handles, the markers each format reads, and the edge characters around them.
const PIECES = [
  "@docs", "@devtool", "@ops-bot", "@drew", "@nobody", "a@docs", "@@docs", "@docs_x", "@Docs", "(@docs)", "@docs,", "@d",
  "`", "``", "```", "```sh", "`@docs`", "\n", "\n\n", "> ", ">", "- ", "* ", "**", "*", "_", "__", "~", "~~", "||", "\\", "\\@", "[", "]", "(", ")",
  "[x](https://x.test)", "[@docs](https://x.test/@devtool)", "![a](https://i.test/p.png)", "![](https://i.test/@docs.png)", "https://x.test/@docs", "[x](javascript:run)",
  " ", " ", " ", "word", "words here", "é", " ", " ", "\t", "\r\n", "!", ".", "-", "#", "0",
];
const FORMATS = ["markdown", "markdown", "markdownv2", "plain"] as const;

/** n fuzzed message bodies with a format each. Every body is a valid message (not blank, at most 5 links). */
export function fuzzBodies(n: number, seed = 7): { body: string; format: (typeof FORMATS)[number] }[] {
  const next = rng(seed);
  const out: { body: string; format: (typeof FORMATS)[number] }[] = [];
  while (out.length < n) {
    const parts = 1 + Math.floor(next() * 14);
    let body = "";
    for (let i = 0; i < parts; i++) body += PIECES[Math.floor(next() * PIECES.length)]!;
    if (body.trim() === "" || (body.match(/https?:\/\/[^\s<>]/gi) ?? []).length > 5) continue;
    out.push({ body, format: FORMATS[Math.floor(next() * FORMATS.length)]! });
  }
  return out;
}
