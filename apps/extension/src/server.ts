/**
 * serverOrigin turns what the owner typed into the origin of a Convoz server, or null. Only https, and http on localhost,
 * fit inside the optional host permissions, so nothing else is accepted.
 */
export function serverOrigin(typed: string): string | null {
  let url: URL;
  try {
    url = new URL(typed.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) return url.origin;
  return null;
}
