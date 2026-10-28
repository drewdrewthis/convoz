// The route table: every URL the server serves the app at, how its page is framed, and the feature that draws it. Each
// feature is its own chunk, loaded through its index.ts before the first render (so a page never flashes empty). The two first
// screens (Now and the conversation list) and Work (Now and the rail show its late items) are the exception: they are in the main bundle, which a cold page carries inline
// (design §12.2), so they show without another request. Features that draw inside other pages instead of at a URL (rail,
// threads, voice, search, pins-stars, notifications, apps-host) are mounted by their host page through that feature's index.ts.
// Prototype v41 names each screen.
import type { ComponentType } from "react";
import * as conversations from "../features/conversations/index.ts";
import { Now } from "../features/now/index.ts";
import { Work } from "../features/work/index.ts";

export interface PageDef {
  name: string;
  /** The tab title before the page names itself: "<title> - Convoz". */
  title: string;
  heading: string;
  /** focus: the wordmark and one task. shell: the signed-in app with the tab bar. chat: a full-screen conversation. */
  frame: "focus" | "shell" | "chat";
  /** Reachable without a session, so a 401 must not send the browser to sign in. */
  public?: boolean;
  /** The page names itself once it knows (a setup link says what it is worth). */
  hideHeading?: boolean;
  tab?: "now" | "chats" | "work" | "crew";
  /** Where the top bar's Back goes. */
  back?: string;
  /** A "New conversation" button floats above the tab bar. */
  newChat?: boolean;
  /** The top bar says how many asks wait ("2 open"). */
  open?: boolean;
  /** Loads the page's feature chunk and picks its page. */
  load: () => Promise<ComponentType>;
  /** The page sets the `tfus` mark once it shows what the person came for (shared/perf.ts); other work waits for that. */
  useful?: boolean;
}

const page = (def: PageDef) => def;

export const PAGES = {
  bootstrap: page({ name: "bootstrap", title: "Set up Convoz", heading: "Welcome to Convoz", frame: "focus", public: true, hideHeading: true, load: () => import("../features/onboarding/index.ts").then((f) => f.Bootstrap) }),
  signin: page({ name: "signin", title: "Sign in", heading: "Sign in", frame: "focus", public: true, load: () => import("../features/auth/index.ts").then((f) => f.SignIn) }),
  recover: page({ name: "recover", title: "Use a recovery code", heading: "Use a recovery code", frame: "focus", public: true, load: () => import("../features/auth/index.ts").then((f) => f.Recover) }),
  onboarding: page({ name: "onboarding", title: "Set up a second way in", heading: "Set up a second way in", frame: "focus", load: () => import("../features/onboarding/index.ts").then((f) => f.Onboarding) }),
  now: page({ name: "now", title: "Now", heading: "Now", frame: "shell", tab: "now", open: true, useful: true, load: () => Promise.resolve(Now) }),
  chats: page({ name: "chats", title: "Conversations", heading: "Conversations", frame: "shell", tab: "chats", newChat: true, back: "/", useful: true, load: () => Promise.resolve(conversations.Conversations) }),
  chat: page({ name: "chat", title: "Conversation", heading: "Conversation", frame: "chat", load: conversations.loadConversation }),
  notfound: page({ name: "notfound", title: "Conversation not found", heading: "Conversation not found", frame: "shell", tab: "chats", back: "/chats", load: conversations.loadNotFound }),
  trash: page({ name: "trash", title: "Trash", heading: "Trash", frame: "shell", back: "/account", load: conversations.loadTrash }),
  work: page({ name: "work", title: "Work", heading: "Work", frame: "shell", tab: "work", back: "/", load: () => Promise.resolve(Work) }),
  crew: page({ name: "crew", title: "Crew", heading: "Crew", frame: "shell", tab: "crew", back: "/", load: () => import("../features/crew/index.ts").then((f) => f.Crew) }),
  agent: page({ name: "agent", title: "Agent", heading: "Agent", frame: "shell", tab: "crew", back: "/crew", load: () => import("../features/crew/index.ts").then((f) => f.AgentProfile) }),
  machines: page({ name: "machines", title: "Machines", heading: "Machines", frame: "shell", tab: "crew", back: "/crew", load: () => import("../features/crew/index.ts").then((f) => f.Machines) }),
  passkeys: page({ name: "passkeys", title: "Passkeys", heading: "Passkeys", frame: "shell", back: "/", load: () => import("../features/settings/index.ts").then((f) => f.Passkeys) }),
  recovery: page({ name: "recovery", title: "Recovery codes", heading: "Recovery codes", frame: "shell", back: "/", load: () => import("../features/settings/index.ts").then((f) => f.RecoveryCodes) }),
  settings: page({ name: "settings", title: "Settings", heading: "Settings", frame: "shell", back: "/account", load: () => import("../features/settings/index.ts").then((f) => f.Settings) }),
  privacy: page({ name: "privacy", title: "Privacy & security", heading: "Privacy & security", frame: "shell", back: "/settings", load: () => import("../features/settings/index.ts").then((f) => f.Privacy) }),
  exportData: page({ name: "export", title: "Export your data", heading: "Export your data", frame: "shell", back: "/settings/privacy", load: () => import("../features/settings/index.ts").then((f) => f.ExportData) }),
  deleteData: page({ name: "delete", title: "Delete my data", heading: "Delete my data", frame: "shell", back: "/settings/privacy", load: () => import("../features/settings/index.ts").then((f) => f.DeleteData) }),
  account: page({ name: "account", title: "Account", heading: "Account", frame: "shell", back: "/", load: () => import("../features/settings/index.ts").then((f) => f.Account) }),
};

const EXACT: Record<string, PageDef> = {
  "/": PAGES.now,
  "/bootstrap": PAGES.bootstrap,
  "/signin": PAGES.signin,
  "/recover": PAGES.recover,
  "/onboarding": PAGES.onboarding,
  "/chats": PAGES.chats,
  "/chats/new": PAGES.chat,
  "/work": PAGES.work,
  "/delivery": PAGES.work, // the old address; the page puts /work in the address bar
  "/crew": PAGES.crew,
  "/crew/machines": PAGES.machines,
  "/settings": PAGES.settings,
  "/settings/privacy": PAGES.privacy,
  "/settings/passkeys": PAGES.passkeys,
  "/settings/recovery": PAGES.recovery,
  "/settings/export": PAGES.exportData,
  "/settings/delete": PAGES.deleteData,
  "/account": PAGES.account,
  "/trash": PAGES.trash,
};

const PATTERNS: [RegExp, PageDef][] = [
  [/^\/chats\/[^/]+$/, PAGES.chat],
  [/^\/crew\/[^/]+$/, PAGES.agent],
  [/^\/now\/machine\/[^/]+$/, PAGES.now], // a machine request's deep link (design §9); its card opens on Now
];

/**
 * route picks the page of a path. The server answers 404 (and marks the document data-status="404") for a conversation that
 * does not exist or is not the owner's; that, and any path the table does not know, is the not-found page.
 */
export function route(path: string, status: string | undefined): PageDef {
  if (status === "404") return PAGES.notfound;
  return EXACT[path] ?? PATTERNS.find(([re]) => re.test(path))?.[1] ?? PAGES.notfound;
}
