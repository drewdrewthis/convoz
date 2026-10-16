import path from "node:path";

/** Absolute path of the repo root (e2e/lib -> repo). */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..");
