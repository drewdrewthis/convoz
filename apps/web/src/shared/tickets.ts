// WebAuthn tickets.
//
// The one rule that shapes this file: iOS Safari allows ONE WebAuthn ceremony per tap, and only while the tap is fresh.
// So every ceremony button works from a Ticket: the options are fetched BEFORE the tap, the button waits (disabled) until
// they are ready, and the click handler calls navigator.credentials.get/create before any await. A step-up that needs two
// ceremonies (add a passkey) is two taps.
import type { StepUpAction } from "@convoz/api-client";
import { call, client } from "./api.ts";

type Kind = "get" | "create";
interface Options {
  ceremony_id: string;
  publicKey: PublicKeyCredentialRequestOptions | PublicKeyCredentialCreationOptions;
}
/** What a finished prompt sends to a verify route. */
export interface Started {
  ceremony_id: string;
  credential: Record<string, unknown>;
}

/** The server keeps a ceremony 5 minutes; leave time for the prompt itself. */
const TICKET_MAX_AGE = 3 * 60_000;
const live = new Set<Ticket>();

/** The part of a ticket a ceremony button needs (a two-step sheet hands it whichever ticket the next tap uses). */
export interface TicketLike {
  readonly ready: boolean;
  stale(): boolean;
  refresh(): void;
  subscribe(fn: () => void): () => void;
}

/**
 * A Ticket holds the options of one ceremony, fetched before the tap. `refresh` fetches again (a ceremony is single use and
 * lives 5 minutes); `use` starts the browser prompt and must be called straight from a click handler. Subscribers hear every
 * change of `ready`, so the button can follow it.
 */
export class Ticket implements TicketLike {
  ready = false;
  private data: Options | null = null;
  private gen = 0;
  private timer = 0;
  private at = 0;
  private listeners = new Set<() => void>();

  constructor(
    private kind: Kind,
    private load: () => Promise<Options>,
    private onError?: (err: unknown) => void,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** stale: the options are too old to start a prompt with (a page that slept keeps a ticket the server forgot). */
  stale(): boolean {
    return this.ready && Date.now() - this.at > TICKET_MAX_AGE;
  }

  refresh = async (): Promise<void> => {
    const gen = ++this.gen;
    live.add(this);
    clearTimeout(this.timer);
    this.ready = false;
    this.data = null;
    this.changed();
    try {
      const data = await this.load();
      if (gen !== this.gen) return;
      this.data = data;
      this.ready = true;
      this.at = Date.now();
      this.timer = window.setTimeout(this.refresh, TICKET_MAX_AGE); // before the server forgets it
    } catch (err) {
      if (gen === this.gen && this.onError) this.onError(err);
    }
    if (gen === this.gen) this.changed();
  };

  /** use opens the browser prompt at once and resolves with what the verify route takes. */
  use(): Promise<Started> {
    const { ceremony_id: id, publicKey } = this.data!;
    this.ready = false;
    this.data = null;
    clearTimeout(this.timer);
    this.changed();
    const prompt =
      this.kind === "get"
        ? navigator.credentials.get({ publicKey: publicKey as PublicKeyCredentialRequestOptions })
        : navigator.credentials.create({ publicKey: publicKey as PublicKeyCredentialCreationOptions });
    return prompt.then((credential) => ({ ceremony_id: id, credential: (credential as PublicKeyCredential).toJSON() as Record<string, unknown> }));
  }

  drop(): void {
    this.gen++;
    clearTimeout(this.timer);
    this.ready = false;
    live.delete(this);
    this.changed();
  }
}

// A hidden tab throttles timers, so a ticket can outlive the server's copy. Coming back to the page fetches again.
function refreshStale(): void {
  if (document.visibilityState === "hidden") return;
  for (const t of live) if (t.stale()) t.refresh();
}
document.addEventListener("visibilitychange", refreshStale);
window.addEventListener("pageshow", refreshStale);

interface ServerOptions {
  ceremony_id: string;
  options: { publicKey: any };
}

const parseGet = (o: ServerOptions["options"]) => PublicKeyCredential.parseRequestOptionsFromJSON(o.publicKey);
const parseCreate = (o: ServerOptions["options"]) => PublicKeyCredential.parseCreationOptionsFromJSON(o.publicKey);

export const loginTicket = (onError: (err: unknown) => void) =>
  new Ticket("get", async () => {
    const s = await call(client.POST("/api/auth/passkey/login/options", { body: {} }));
    return { ceremony_id: s.ceremony_id, publicKey: parseGet(s.options) };
  }, onError);

export const stepUpTicket = (action: StepUpAction, target: number | null, onError: (err: unknown) => void) =>
  new Ticket("get", async () => {
    const s = await call(client.POST("/api/auth/step-up/options", { body: target == null ? { action } : { action, target_id: target } }));
    return { ceremony_id: s.ceremony_id, publicKey: parseGet(s.options) };
  }, onError);

export const registerTicket = (onError: (err: unknown) => void) =>
  new Ticket("create", async () => {
    const s = await call(client.POST("/api/auth/passkey/register/options", { body: {} }));
    return { ceremony_id: s.ceremony_id, publicKey: parseCreate(s.options) };
  }, onError);

export const bootstrapTicket = (fetchOptions: () => Promise<ServerOptions>, onError: (err: unknown) => void) =>
  new Ticket("create", async () => {
    const s = await fetchOptions();
    return { ceremony_id: s.ceremony_id, publicKey: parseCreate(s.options) };
  }, onError);

/** finishStepUp finishes a get ceremony that `ticket.use()` started and returns the step-up id for X-Convoz-Step-Up. */
export async function finishStepUp(started: Promise<Started>): Promise<string> {
  const done = await call(client.POST("/api/auth/step-up/verify", { body: await started }));
  return String(done.step_up_id);
}

/** supported: this browser can make and use passkeys from JSON options. */
export const supported = (): boolean => "PublicKeyCredential" in window && "parseCreationOptionsFromJSON" in PublicKeyCredential;
