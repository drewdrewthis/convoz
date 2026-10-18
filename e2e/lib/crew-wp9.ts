import type { BrowserContext, Locator, Page } from "@playwright/test";
import { chatWorld, startSession, type World } from "./chat.ts";
import { sidOf, type CliMachine } from "./cli.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { allow, ANY, revokeAgentKey, signInBrowser } from "./machines.ts";
import { idsOf } from "./wp3.ts";

/** What the Crew scenarios share: a fresh server, owner "drew", the agents, machine "box-2", and the owner's browser signed in last. */
export interface CrewWorld {
  w: World;
  ids: Record<string, number>;
  /** One live session per handle in `live`: its local id and lease. */
  sessions: Record<string, { sid: string; lease: string }>;
}

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext };

/**
 * Background of crew.feature. `allowed` is box-2's allow-list: handles, or "any". `plaintext` lets a scenario seed rows the API has no
 * route for yet (asks) and read machine rows. All API step-ups happen before the browser takes the passkey (its counter continues there).
 */
export async function crewWorld(
  fx: Fx,
  o: { agents: string[]; allowed?: string[] | "any"; plaintext?: boolean; live?: string[]; beforeSignIn?: (c: CrewWorld) => Promise<void> },
): Promise<CrewWorld> {
  const list = o.allowed === "any" ? ANY : allow(...(o.allowed ?? o.agents));
  const w = await chatWorld(fx.server, { agents: o.agents, allowed: list, env: o.plaintext ? { CONVOZ_TEST_PLAINTEXT: "1" } : {} });
  const sessions: CrewWorld["sessions"] = {};
  for (const h of o.live ?? []) sessions[h] = await startSession(w.box, h, `crew-${h}`);
  const c = { w, ids: await idsOf(w.owner), sessions };
  await o.beforeSignIn?.(c);
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return c;
}

/** The owner revokes an agent's key over the API, the way Crew does (one tap and a confirm, no passkey). */
export async function disableAgent(c: CrewWorld, handle: string): Promise<void> {
  const id = c.ids[handle]!;
  const res = await revokeAgentKey(c.w.owner, id);
  if (res.status !== 200) throw new Error(`disable ${handle}: ${res.status} ${res.text}`);
}

/** The Crew list row of an agent: a link whose name holds its handle. */
export const crewRow = (page: Page, handle: string): Locator => page.getByRole("link", { name: new RegExp(`\\b${handle}\\b`) }).filter({ has: page.locator(".ring") });

/** The dialog (sheet) with this name. */
export const sheetNamed = (page: Page, name: string | RegExp): Locator => page.getByRole("dialog", { name });

/** The computed colour of a design token, read through a probe element, so a test compares what is drawn and not a copy of the hex. */
export async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement("i");
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/** A style of the ring's ::before (its look) or ::after (the hollow dot). */
export const ringStyle = (ring: Locator, pseudo: "::before" | "::after", prop: string): Promise<string> =>
  ring.evaluate((el, [p, name]) => getComputedStyle(el, p as string).getPropertyValue(name as string), [pseudo, prop]);

/** A session of `handle` on `box` with its own label and Claude session id; returns the local session id. */
export async function labelledSession(box: CliMachine, handle: string, label: string): Promise<string> {
  const res = await box.sessionStart(handle, ["--label", label], { claude: `claude-TESTONLY-${label.replace(/[^a-z0-9]/gi, "")}` });
  if (res.code !== 0) throw new Error(`session start ${label}: ${res.code}\n${res.stderr}`);
  return sidOf(res);
}
