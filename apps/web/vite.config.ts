import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, createBrotliCompress } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, minifySync, parseSync, Visitor, type Plugin, type Rolldown } from "vite";

// Files the app shell needs that Vite does not emit (they keep their names; the server serves them). The shell page itself is
// the one document every page URL answers with, fetched from the public /signin so the install needs no session.
const FIXED_FILES = ["/manifest.webmanifest", "/favicon.ico", "/apple-touch-icon.png", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/lookalikes.js", "/assets/settings/theme-boot.js"];
const SHELL_URL = "/signin?shell=1";

/**
 * The list the service worker precaches (Workbox injectManifest): every hashed file of the build (revision null, the name is the
 * version), the fixed files and the shell page (both revised by a hash of the build). It replaces `self.__WB_MANIFEST` in sw.js.
 */
function precacheManifest(): Plugin {
  return {
    name: "precache-manifest",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const worker = bundle["sw.js"];
      if (!worker || worker.type !== "chunk") return;
      const hashed = Object.keys(bundle).filter((name) => name.startsWith("assets/") && name !== "sw.js");
      const html = bundle["index.html"];
      const build = createHash("sha256").update(hashed.join()).update(html && html.type === "asset" ? html.source : "").digest("hex").slice(0, 16);
      const list = [
        ...hashed.map((name) => ({ url: `/${name}`, revision: null })),
        ...[...FIXED_FILES, SHELL_URL].map((url) => ({ url, revision: build })),
      ];
      worker.code = worker.code.replace("self.__WB_MANIFEST", JSON.stringify(list));
    },
  };
}

/**
 * The chunks each first screen needs beyond the main bundle, by URL (src/early.ts reads the list): the feature index (and, for a
 * conversation, its pages module) that the route loads. "/chats/:id" stands for every conversation URL.
 */
const FIRST_SCREENS: Record<string, string[]> = {
  "/": ["src/features/now/index.ts"],
  "/chats": ["src/features/conversations/index.ts"],
  "/chats/:id": ["src/features/conversations/index.ts", "src/features/conversations/pages.ts"],
};

/**
 * earlyScript puts the head-start script (src/early.ts, its own entry with no imports) first in the shell page, async so it runs
 * the moment it arrives, with the list of each first screen's chunks in <meta name="convoz-pages">. Chunks the shell already
 * loads (the main bundle and what it imports) are left out. It runs before precacheManifest, which hashes the final page.
 */
function earlyScript(): Plugin {
  return {
    name: "early-script",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const html = bundle["index.html"];
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const early = chunks.find((c) => c.name === "early" && c.isEntry);
      if (!html || html.type !== "asset" || !early) return;
      const main = chunks.find((c) => c.name === "main" && c.isEntry);
      const loaded = new Set<string>(main ? [main.fileName, ...main.imports] : []);
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const withImports = (file: string, out: Set<string>) => {
        if (out.has(file) || loaded.has(file)) return;
        out.add(file);
        for (const dep of byFile.get(file)?.imports ?? []) withImports(dep, out);
      };
      const pages: Record<string, string[]> = {};
      for (const [url, modules] of Object.entries(FIRST_SCREENS)) {
        const files = new Set<string>();
        for (const m of modules) {
          const id = path.resolve(import.meta.dirname, m);
          const chunk = chunks.find((c) => c.moduleIds.includes(id));
          if (!chunk) throw new Error(`early-script: no chunk holds ${m}`);
          withImports(chunk.fileName, files);
        }
        pages[url] = [...files].map((f) => `/${f}`);
      }
      const meta = JSON.stringify(pages).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const tags = `<meta name="convoz-pages" content="${meta}">\n<script type="module" async crossorigin src="/${early.fileName}"></script>\n`;
      const source = String(html.source);
      const at = source.indexOf("<script");
      if (at < 0) throw new Error("early-script: the shell page has no script");
      html.source = source.slice(0, at) + tags + source.slice(at);
    },
  };
}

/*
 * THE COLD PAGE (design §12.2). On a slow link every request wave costs a round trip (about 560 ms on Fast-3G), so the first screen of
 * a cold load (Now at /, the conversation list at /chats) must arrive in the document itself: its boot script, its stylesheet, its
 * code and its first reads. The build makes that page's static part (cold-head.html, and a brotli copy of it); the server appends
 * the confusables script and the reads as a JSON data block (console.ColdPage).
 *
 * The main bundle is one file with no static import, so the page can carry it whole. An inline module has no URL, so the lazy chunks
 * cannot import it by name: the main bundle hands its exports to them through one frozen registry (coldBuild), the same way on
 * the cold page and on the lean shell (the service worker's copy, which loads the same file by URL). No dev server runs this app (the
 * package has no dev script): the build is the only path, and both pages go through the registry.
 */

/** The registry key: a global symbol, so no page script can reach it by a property name by accident. */
const EAGER = 'globalThis[Symbol.for("convoz.eager")]';

type Program = ReturnType<typeof parseSync>["program"];
type Node = { type: string; start: number; end: number; [key: string]: unknown };

function parseChunk(name: string, code: string): Program {
  const parsed = parseSync(name, code, { sourceType: "module" });
  if (parsed.errors.length) throw new Error(`eager-registry: ${name} does not parse: ${parsed.errors[0]!.message}`);
  return parsed.program;
}

/** splice applies [start, end, text] edits (in any order) to code. */
function splice(code: string, edits: [number, number, string][]): string {
  let out = code;
  for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + text + out.slice(end);
  return out;
}

const nameOf = (n: unknown) => {
  const node = n as { type: string; name?: string; value?: string };
  return node.type === "Identifier" ? node.name! : node.value!;
};

/** bindingNames lists the names a declaration pattern binds (const {a, b: [c]} = ... binds a and c). */
function bindingNames(pattern: Node, out: string[] = []): string[] {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      break;
    case "ObjectPattern":
      for (const p of pattern.properties as Node[]) bindingNames((p.type === "RestElement" ? p.argument : p.value) as Node, out);
      break;
    case "ArrayPattern":
      for (const e of pattern.elements as (Node | null)[]) if (e) bindingNames(e, out);
      break;
    case "RestElement":
      bindingNames(pattern.argument as Node, out);
      break;
    case "AssignmentPattern":
      bindingNames(pattern.left as Node, out);
      break;
  }
  return out;
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** children walks the child nodes of an ESTree node. */
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || !value || typeof value !== "object") continue;
    for (const item of Array.isArray(value) ? value : [value]) if (item && typeof (item as Node).type === "string") out.push(item as Node);
  }
  return out;
}

/** hoisted collects what a function body declares for the whole function: its var names (not those of nested functions). */
function hoisted(node: Node, into: Set<string>): void {
  for (const child of children(node)) {
    if (FUNCTIONS.has(child.type)) continue;
    if (child.type === "VariableDeclaration" && child.kind === "var") for (const d of child.declarations as Node[]) bindingNames(d.id as Node).forEach((n) => into.add(n));
    hoisted(child, into);
  }
}

/** lexical is what a list of statements declares for its block: let, const, class and (strict mode) function names. */
function lexical(statements: Node[]): Set<string> {
  const out = new Set<string>();
  for (const st of statements) {
    if (st.type === "VariableDeclaration" && st.kind !== "var") for (const d of st.declarations as Node[]) bindingNames(d.id as Node).forEach((n) => out.add(n));
    if ((st.type === "ClassDeclaration" || st.type === "FunctionDeclaration") && st.id) out.add(nameOf(st.id));
  }
  return out;
}

/**
 * reassignedExports names the exports of a chunk whose module-level binding is assigned inside a function. The registry hands out
 * the value each export has when the main bundle has run, so a binding a function assigns later (an `export let` that changes, a
 * bundler's lazy module init) would leave a lazy chunk with a stale copy: the build fails on one instead (export a function or an
 * object that holds the state). Assignments at the top level run before the registry is filled, so they are safe. A name that an
 * enclosing function or block declares again is that one, not the module's.
 */
function reassignedExports(code: string, fileName: string): string[] {
  const program = parseChunk(fileName, code) as unknown as Node;
  const assigned = new Set<string>();
  const hit = (name: string, scopes: Set<string>[], inFunction: boolean) => {
    if (inFunction && !scopes.some((s) => s.has(name))) assigned.add(name);
  };
  const targets = (target: Node, scopes: Set<string>[], inFunction: boolean) => {
    if (target.type === "Identifier") hit(nameOf(target), scopes, inFunction);
    else if (target.type === "ObjectPattern" || target.type === "ArrayPattern" || target.type === "AssignmentPattern" || target.type === "RestElement") bindingNames(target).forEach((n) => hit(n, scopes, inFunction));
  };
  const walk = (node: Node, scopes: Set<string>[], inFunction: boolean): void => {
    if (FUNCTIONS.has(node.type)) {
      const own = new Set<string>();
      if (node.type === "FunctionExpression" && node.id) own.add(nameOf(node.id));
      for (const param of node.params as Node[]) bindingNames(param).forEach((n) => own.add(n));
      if (node.type !== "ArrowFunctionExpression") own.add("arguments");
      hoisted(node.body as Node, own);
      for (const child of children(node)) walk(child, [...scopes, own], true);
      return;
    }
    let inner = scopes;
    if (node.type === "BlockStatement" || node.type === "StaticBlock" || node.type === "Program") inner = node.type === "Program" ? scopes : [...scopes, lexical(node.body as Node[])];
    else if (node.type === "SwitchStatement") inner = [...scopes, lexical((node.cases as Node[]).flatMap((c) => c.consequent as Node[]))];
    else if (node.type === "CatchClause" && node.param) inner = [...scopes, new Set(bindingNames(node.param as Node))];
    else if (node.type === "ClassExpression" && node.id) inner = [...scopes, new Set([nameOf(node.id)])];
    else if (node.type === "ForStatement" || node.type === "ForInStatement" || node.type === "ForOfStatement") {
      const head = (node.init ?? node.left) as Node | null;
      if (head?.type === "VariableDeclaration" && head.kind !== "var") inner = [...scopes, new Set((head.declarations as Node[]).flatMap((d) => bindingNames(d.id as Node)))];
      else if (head && node.type !== "ForStatement") targets(head, scopes, inFunction);
    }
    if (node.type === "AssignmentExpression") targets(node.left as Node, inner, inFunction);
    if (node.type === "UpdateExpression") targets(node.argument as Node, inner, inFunction);
    for (const child of children(node)) walk(child, inner, inFunction);
  };
  walk(program, [], false);
  const out: string[] = [];
  for (const node of program.body as Node[]) {
    if (node.type !== "ExportNamedDeclaration" || node.source) continue;
    for (const sp of (node.specifiers as Node[]) ?? []) if (assigned.has(nameOf(sp.local))) out.push(`${nameOf(sp.exported)} (${nameOf(sp.local)})`);
    const declared = node.declaration as Node | null;
    if (declared?.type === "VariableDeclaration") for (const d of declared.declarations as Node[]) for (const n of bindingNames(d.id as Node)) if (assigned.has(n)) out.push(n);
  }
  return out;
}

/**
 * registerExports turns the main bundle's export list into the registry: a frozen object of its exports, set once it has run. A
 * second copy of the bundle in the same page would mean two app instances (two Preacts, two stores), so it throws before it runs.
 * Its dynamic imports become absolute (/assets/...): inline, a relative URL would resolve against the page, not assets/.
 */
function registerExports(code: string, fileName: string): string {
  const program = parseChunk(fileName, code);
  const edits: [number, number, string][] = [[0, 0, `if(${EAGER})throw Error("convoz: the app bundle ran twice in one page");`]];
  let exported = false;
  for (const node of program.body as unknown as Node[]) {
    if (node.type === "ExportDefaultDeclaration" || node.type === "ExportAllDeclaration" || (node.type === "ExportNamedDeclaration" && (node.declaration || node.source))) {
      throw new Error(`eager-registry: ${fileName} has an export the registry cannot carry: ${code.slice(node.start, Math.min(node.end, node.start + 80))}`);
    }
    if (node.type === "ImportDeclaration") throw new Error(`eager-registry: ${fileName} imports ${String((node.source as Node).value)}; it must be one file`);
    if (node.type !== "ExportNamedDeclaration") continue;
    const fields = (node.specifiers as Node[]).map((sp) => `${JSON.stringify(nameOf(sp.exported))}:${nameOf(sp.local)}`);
    edits.push([node.start, node.end, `${EAGER}=Object.freeze({${fields.join(",")}});`]);
    exported = true;
  }
  if (!exported) edits.push([code.length, code.length, `${EAGER}=Object.freeze({});`]);
  new Visitor({
    ImportExpression(node: Node) {
      const source = node.source as Node;
      if (source.type === "Literal" && typeof source.value === "string" && source.value.startsWith("./")) edits.push([source.start, source.end, JSON.stringify(`/assets/${source.value.slice(2)}`)]);
    },
  } as never).visit(program);
  const meta = importMetaOutsidePreload(program as unknown as Node);
  if (meta) throw new Error(`eager-registry: ${fileName} uses import.meta (${code.slice(meta.start, meta.end + 40)}), which is the page's URL when the bundle is inline`);
  return splice(code, edits);
}

/**
 * importMetaOutsidePreload finds an import.meta that depends on the bundle's own URL. Vite's preload helper (importMetaResolve)
 * is the one allowed use: it resolves absolute paths (/assets/...), which come out the same from the page's URL.
 */
function importMetaOutsidePreload(node: Node, inHelper = false): Node | undefined {
  if (node.type === "MetaProperty" && !inHelper) return node;
  const helper = inHelper || (node.type === "FunctionDeclaration" && node.id != null && nameOf(node.id) === "importMetaResolve");
  for (const child of children(node)) {
    const found = importMetaOutsidePreload(child, helper);
    if (found) return found;
  }
  return undefined;
}

/** importFromRegistry turns a lazy chunk's static import of the main bundle into a read of the registry. */
function importFromRegistry(code: string, fileName: string, main: string): string {
  const program = parseChunk(fileName, code);
  const from = (node: Node) => {
    const value = String((node.source as Node | null)?.value ?? "");
    return value === `./${path.basename(main)}` || value === `/${main}`;
  };
  const edits: [number, number, string][] = [];
  for (const node of program.body as unknown as Node[]) {
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source && from(node)) throw new Error(`eager-registry: ${fileName} re-exports the main bundle`);
    if (node.type !== "ImportDeclaration" || !from(node)) continue;
    const named: string[] = [];
    let namespace = "";
    for (const sp of node.specifiers as Node[]) {
      if (sp.type === "ImportNamespaceSpecifier") namespace = `const ${nameOf(sp.local)}=${EAGER};`;
      else if (sp.type === "ImportSpecifier") named.push(`${JSON.stringify(nameOf(sp.imported))}:${nameOf(sp.local)}`);
      else throw new Error(`eager-registry: ${fileName} imports the main bundle's default export`);
    }
    edits.push([node.start, node.end, namespace + (named.length ? `const{${named.join(",")}}=${EAGER};` : "")]);
  }
  new Visitor({
    ImportExpression(node: Node) {
      if (from(node)) throw new Error(`eager-registry: ${fileName} imports the main bundle dynamically`);
    },
  } as never).visit(program);
  return splice(code, edits);
}

/** The look before the first paint: the settings module's classic script (the server checks the cold page carries its exact bytes). */
const THEME_BOOT = path.resolve(import.meta.dirname, "../convoz/internal/server/settings/boot.js");

/** brotliFlushed is `data` brotli-compressed at the highest quality and flushed but not finished, so the server can append to it. */
function brotliFlushed(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    const out: Buffer[] = [];
    z.on("data", (b: Buffer) => out.push(b));
    z.on("error", reject);
    z.write(data);
    z.flush(constants.BROTLI_OPERATION_FLUSH, () =>
      setImmediate(() => {
        z.close();
        resolve(Buffer.concat(out));
      }),
    );
  });
}

/**
 * coldHead is the cold page's static part: the shell page with the boot script, the stylesheet and the main bundle inline, cut before
 * </body>. The server appends the rest (console.ColdPage). The head-start script and the chunk list are left out: the first screen is
 * already in the page.
 */
function coldHead(html: string, main: { fileName: string; code: string }, css: { fileName: string; source: string }): string {
  // In a script element only "</script" ends it, and only "<!--" can make a later one not end it (HTML's escaped states):
  // the first is escaped (it can only be in a string, a template, a regular expression or a comment, where "<\/" reads the same),
  // the second fails the build.
  const js = main.code.replace(/<\/(script)/gi, "<\\/$1");
  const reparsed = parseSync(main.fileName, js, { sourceType: "module" });
  if (reparsed.errors.length) throw new Error(`cold-page: the main bundle does not parse after escaping </script: ${reparsed.errors[0]!.message}`);
  if (js.includes("<!--") || /<\/style/i.test(css.source)) throw new Error("cold-page: the main bundle or stylesheet holds markup that would end its inline block");
  const swap = (page: string, from: RegExp, to: string) => {
    if (!from.test(page)) throw new Error(`cold-page: the shell page has no ${from}`);
    return page.replace(from, () => to);
  };
  let page = html;
  page = swap(page, /<meta name="convoz-pages"[^>]*>\n/, "");
  page = swap(page, /<script type="module" async crossorigin src="\/assets\/early-[^"]+"><\/script>\n/, "");
  page = swap(page, /<script src="\/assets\/settings\/theme-boot\.js"><\/script>/, `<script>${readFileSync(THEME_BOOT, "utf8")}</script>`);
  page = swap(page, /<!-- Deferred scripts[^>]*-->\n<script src="\/assets\/lookalikes\.js"[^>]*><\/script>\n/, "");
  page = page.replace(/\s*<link rel="modulepreload"[^>]*>/g, "");
  page = swap(page, new RegExp(`<link rel="stylesheet"[^>]*href="/${css.fileName}">`), `<style>${css.source}</style>`);
  page = swap(page, new RegExp(`<script type="module"[^>]*src="/${main.fileName}"></script>`), `<script type="module">${js}</script>`);
  const end = page.indexOf("</body>");
  if (end < 0) throw new Error("cold-page: the shell page has no </body>");
  return page.slice(0, end);
}

/**
 * The modules the main bundle's chunk group leaves out: the worker's own (its entry and modules, and what only they use) and the
 * head-start script's. Every other module the page loads at start goes into the main bundle, so a module the worker shares with the
 * page would make the worker import the page's bundle; coldBuild fails such a build.
 */
const OUTSIDE_MAIN = /[\\/]src[\\/](sw[\\/](worker|cache|push|errors|module)\.ts|shared[\\/](pagePath|devScope)\.ts|early\.ts|first-reads\.json)$|node_modules[\\/].*workbox-/;

/**
 * coldBuild finishes the build once Vite has written its files, in one ordered pass over the chunks as the bundler rendered them
 * (unminified: the bundler's minifier is off, as it would hide which bindings the source assigns):
 *  1. eagerRegistry: the main bundle must be one self-contained file, share no binding a function assigns (a lazy chunk would keep a
 *     stale copy), and use no import.meta (the page's URL when inline). Its exports become the registry; the lazy chunks read it.
 *  2. every chunk is minified and written again.
 *  3. the cold page's static part: cold-head.html and its brotli copy (cold-head.html.br), and web/first-reads.json for the server.
 *  4. precompress: a brotli copy (<file>.br, highest quality) of every script and stylesheet of assets/, which the server sends to a
 *     client that takes brotli (design §12.3): on a slow link the first load is bound by these bytes, and compressing per request
 *     runs at a low quality. The service worker never lists them.
 */
function coldBuild(): Plugin {
  return {
    name: "cold-build",
    apply: "build",
    writeBundle: {
      order: "post",
      sequential: true,
      async handler(options, bundle) {
        const dir = options.dir!;
        const chunks = Object.values(bundle).filter((c): c is Rolldown.OutputChunk => c.type === "chunk");
        const main = chunks.find((c) => c.name === "main" && c.isEntry);
        if (!main) throw new Error("cold-build: no main bundle");
        if (main.imports.length) throw new Error(`eager-registry: the main bundle imports ${main.imports.join(", ")}; it must be one file, a cold page carries it inline`);
        // The worker evaluates every module it imports: a chunk of the page (the main bundle touches the DOM) fails its evaluation, and
        // the browser then registers no worker at all (no offline shell, no push, no update). A module only the worker uses belongs in
        // OUTSIDE_MAIN.
        const worker = chunks.find((c) => c.fileName === "sw.js");
        if (worker?.imports.length) throw new Error(`cold-build: sw.js imports ${worker.imports.join(", ")}; the worker must be one file (add its modules to OUTSIDE_MAIN)`);
        const mutable = reassignedExports(main.code, main.fileName);
        if (mutable.length) throw new Error(`eager-registry: the main bundle shares bindings that a function assigns (${mutable.join(", ")}); a lazy chunk would keep a stale copy. Export a function or an object instead.`);
        const code = new Map<string, string>();
        for (const chunk of chunks) {
          const shared = chunk === main ? registerExports(chunk.code, chunk.fileName) : chunk.fileName === "sw.js" ? chunk.code : importFromRegistry(chunk.code, chunk.fileName, main.fileName);
          const out = minifySync(chunk.fileName, shared, { module: true, compress: true, mangle: true });
          if (out.errors.length) throw new Error(`minify: ${chunk.fileName}: ${out.errors[0]!.message}`);
          code.set(chunk.fileName, out.code);
          writeFileSync(path.join(dir, chunk.fileName), out.code);
        }

        const html = bundle["index.html"];
        const css = Object.values(bundle).find((c): c is Rolldown.OutputAsset => c.type === "asset" && /^assets\/main-[^/]+\.css$/.test(c.fileName));
        if (!html || html.type !== "asset" || !css) throw new Error("cold-page: no shell page or main stylesheet");
        const head = coldHead(String(html.source), { fileName: main.fileName, code: code.get(main.fileName)! }, { fileName: css.fileName, source: String(css.source) });
        writeFileSync(path.join(dir, "cold-head.html"), head);
        const headBr = await brotliFlushed(Buffer.from(head));
        // The server finishes this stream with one last empty meta-block (0x03); it must then decode to exactly the head.
        if (brotliDecompressSync(Buffer.concat([headBr, Buffer.from([0x03])])).toString() !== head) throw new Error("cold-build: cold-head.html.br does not decode to cold-head.html once finished");
        writeFileSync(path.join(dir, "cold-head.html.br"), headBr);
        // The server reads the same list for the reads a cold page carries (src/early.ts asks for them on the lean shell).
        writeFileSync(path.join(dir, "first-reads.json"), readFileSync(path.resolve(import.meta.dirname, "src/first-reads.json")));

        for (const file of Object.values(bundle)) {
          if (!file.fileName.startsWith("assets/") || !/\.(js|css)$/.test(file.fileName)) continue;
          const written = path.join(dir, file.fileName);
          writeFileSync(`${written}.br`, brotliCompressSync(readFileSync(written), { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }));
        }
      },
    },
  };
}

/**
 * Preact stands in for React (design §12.2: the first screen's bytes). CONVOZ_REACT=1 builds the same commit on React, so a
 * difference in behaviour can be told from a difference of the two.
 */
const REACT = process.env.CONVOZ_REACT === "1";
const preact = REACT
  ? []
  : [
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react\/jsx-(dev-)?runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react$/, replacement: "preact/compat" },
    ];

/** The build id the app puts in its error reports: the commit it was built from ("dev" outside a checkout). */
function buildId(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "dev";
  } catch {
    return "dev";
  }
}

// The build lands inside the Go console package, which embeds it (go:embed cannot reach outside its module).
// public/placeholder.txt is copied back after the folder is emptied, so the committed placeholder never shows as deleted.
/**
 * devBuild is the owner's dev build (`vite build --mode dev`, made by .github/workflows/dev-web.yml): the same app served at /dev/
 * by the server's /dev route, from a folder the deploy swaps. It has no cold page (the route serves the lean shell), no service
 * worker (the app registers none in DEV) and no head-start script, so it is a plain Vite build with base /dev/; DEV in the app
 * (shared/base.ts) keeps its paths under /dev/ and shows the DEV badge. It never writes into the Go package: CONVOZ_DEV_WEB_OUT
 * names the folder.
 */
function devBuild() {
  const outDir = process.env.CONVOZ_DEV_WEB_OUT;
  if (!outDir) throw new Error("vite build --mode dev: set CONVOZ_DEV_WEB_OUT to the folder the dev build goes to");
  return {
    base: "/dev/",
    plugins: [react(), tailwindcss()],
    define: { __BUILD__: JSON.stringify(buildId()) },
    resolve: { alias: preact, dedupe: REACT ? [] : ["preact"] },
    build: {
      outDir: path.resolve(outDir),
      emptyOutDir: true,
      assetsDir: "assets",
      modulePreload: { polyfill: false },
      rolldownOptions: { input: { main: path.resolve(import.meta.dirname, "index.html") } },
    },
  };
}

export default defineConfig(({ mode }) => (mode === "dev" ? devBuild() : {
  plugins: [react(), tailwindcss(), earlyScript(), precacheManifest(), coldBuild()],
  define: { __BUILD__: JSON.stringify(buildId()) },
  // dedupe: the packages (ui, app-kit) resolve preact from this app, so the page holds one copy of it.
  resolve: { alias: preact, dedupe: REACT ? [] : ["preact"] },
  build: {
    outDir: path.resolve(import.meta.dirname, "../convoz/internal/server/console/web"),
    // Chunks are minified by coldBuild, after it has read them; the stylesheet as before.
    minify: false,
    cssMinify: true,
    emptyOutDir: true,
    assetsDir: "assets",
    // The CSP allows our own scripts only; the polyfill is not needed by the browsers we serve.
    // The main bundle is never preloaded: it is in the page already (inline, or by its <script>), and no chunk imports it by URL.
    modulePreload: { polyfill: false, resolveDependencies: (_, deps) => deps.filter((dep) => !/^assets\/main-[^/]+\.js$/.test(dep)) },
    rolldownOptions: {
      // The service worker is its own entry at a fixed URL (/sw.js): a worker's scope is the folder of its script.
      // early.ts is an entry of its own so it imports nothing and runs before the main bundle has arrived (earlyScript).
      input: { main: path.resolve(import.meta.dirname, "index.html"), early: path.resolve(import.meta.dirname, "src/early.ts"), sw: path.resolve(import.meta.dirname, "src/sw/worker.ts") },
      // Everything the main entry imports stays in its one file (eagerRegistry checks it): a cold page carries that file inline.
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
        codeSplitting: { groups: [{ name: "main", tags: ["$initial"], test: (id: string) => !OUTSIDE_MAIN.test(id) }] },
      },
    },
  },
}));
