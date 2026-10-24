// AC 1 of issue 44: the extension reads only the active tab, only on a click, and reaches only the one Convoz server.
// Test only: least-access.test.ts checks manifest.json with it; the extension itself never imports this file.

/** The only API permissions the manifest may name. */
export const PERMISSIONS = ["activeTab", "scripting", "sidePanel", "storage"];
/** Host access is never in the manifest: the panel asks at run time for the one server origin, inside these. */
export const OPTIONAL_HOSTS = ["http://localhost/*", "https://*/*"];
const FORBIDDEN_KEYS = ["host_permissions", "content_scripts", "optional_permissions"];

const sameSet = (a: unknown, b: string[]) => Array.isArray(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** leastAccessProblems lists every way a manifest asks for more than the extension needs; empty when it asks for no more. */
export function leastAccessProblems(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!sameSet(manifest.permissions, PERMISSIONS)) problems.push(`permissions must be exactly ${PERMISSIONS.join(", ")}`);
  if (!sameSet(manifest.optional_host_permissions, OPTIONAL_HOSTS)) problems.push(`optional_host_permissions must be exactly ${OPTIONAL_HOSTS.join(", ")}`);
  for (const key of FORBIDDEN_KEYS) if (key in manifest) problems.push(`${key} is not allowed`);
  if (JSON.stringify(manifest).includes("<all_urls>")) problems.push("<all_urls> is not allowed");
  return problems;
}
