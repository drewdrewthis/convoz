// The pages a pushed URL may open: the paths of the app's route table (app/routes.tsx). The worker cannot import that table
// (it would pull every page chunk into the worker), so the paths are listed here; the push spec checks the server's push URLs
// against it.
const PAGES: RegExp[] = [
  /^\/(?:bootstrap|signin|recover|onboarding|chats|chats\/new|crew|crew\/machines|account|trash)?$/,
  /^\/settings(?:\/(?:privacy|passkeys|recovery|export|delete))?$/,
  /^\/(?:chats|crew)\/[^/]+$/,
  /^\/now\/machine\/[^/]+$/,
];

/**
 * pagePath is the path to open for a pushed URL: the URL itself when it is a page of this site, else the Now screen ("/").
 * A pushed URL never sends the owner to another origin or to a path the app has no page for ("Conversation not found").
 */
export function pagePath(url: string | undefined): string {
  if (typeof url !== "string" || !/^\/(?![/\\])[^\u0000-\u001f]*$/.test(url)) return "/";
  const path = url.split(/[?#]/, 1)[0]!;
  return PAGES.some((re) => re.test(path)) ? url : "/";
}
