const DOC = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6";

/** glyphOf is the icon path for a file name: sheet, archive, PDF, text or code, or a plain document (prototype v42 fileIconOf). */
function glyphOf(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (/^(csv|tsv|xls|xlsx)$/.test(ext)) return `${DOC}M8 13h8M8 17h8M11 13v6`;
  if (/^(zip|tar|gz|tgz|7z)$/.test(ext)) return `${DOC}M11 11h2M11 15h2M12 13h2`;
  if (ext === "pdf") return `${DOC}M8 18v-6h2a1.5 1.5 0 0 1 0 3H8`;
  if (/^(log|txt|md|json|js|ts|py|go|yml|yaml|sh)$/.test(ext)) return `${DOC}M8 13h8M8 17h6`;
  return DOC;
}

/** FileGlyph draws the icon that tells a file's kind from its name. It is decorative: the name beside it says what the file is. */
export function FileGlyph({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={glyphOf(name)} />
    </svg>
  );
}
