import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import type { CdpCredential } from "./soft-authenticator.ts";

/**
 * Chromium's CDP virtual authenticator (S1a plan §4.2): ctap2, internal, resident key,
 * user verification on, presence simulated. Chromium only; there is no WebKit here.
 */
export interface VirtualAuthenticator {
  id: string;
  /** Put a credential made by the soft authenticator onto this device. */
  addCredential(c: CdpCredential): Promise<void>;
  /** Credentials on this device (base64 ids). */
  credentials(): Promise<{ credentialId: string; rpId?: string }[]>;
  /** Take the device away (a second device is then a different authenticator). */
  remove(): Promise<void>;
}

export interface WebAuthnHarness {
  cdp: CDPSession;
  add(): Promise<VirtualAuthenticator>;
}

export async function webauthn(context: BrowserContext, page: Page): Promise<WebAuthnHarness> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const add = async (): Promise<VirtualAuthenticator> => {
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return {
      id: authenticatorId,
      addCredential: async (c) => {
        await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: c });
      },
      credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
      remove: async () => {
        await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      },
    };
  };
  return { cdp, add };
}
