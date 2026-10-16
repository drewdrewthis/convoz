import crypto from "node:crypto";

/**
 * A software WebAuthn authenticator for @api and @cli scenarios (S1a plan §4.2).
 * ES256 via node:crypto, "none" attestation, a small CBOR/COSE encoder. It runs the real
 * ceremonies over HTTP, so the server's passkey code is always the code under test.
 * Credential ids start with the bytes "TESTONLY" (fake-token rule).
 */

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new Error("cbor: item too long for this encoder");
}

/** Minimal CBOR encoder: integers, text, bytes, maps (insertion order is kept, as CTAP2 needs). */
export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");
const sha256 = (b: Buffer | string): Buffer => crypto.createHash("sha256").update(b).digest();

export interface SoftCredential {
  id: Buffer;
  privateKey: crypto.KeyObject;
  userHandle: Buffer;
  rpId: string;
  signCount: number;
}

/** What the server sends: `options.publicKey` of go-webauthn's CredentialCreation / CredentialAssertion. */
export interface PublicKeyCreationOptions {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: string; alg: number }[];
  excludeCredentials?: { id: string; type: string }[];
}
export interface PublicKeyRequestOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: { id: string; type: string }[];
  userVerification?: string;
}

export interface CdpCredential {
  credentialId: string;
  isResidentCredential: true;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
}

export class SoftAuthenticator {
  readonly credentials: SoftCredential[] = [];

  readonly rpId: string;
  readonly origin: string;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }), "utf8");
  }

  /** Registration: returns the JSON the server's verify route takes as `credential`. */
  create(options: PublicKeyCreationOptions): Record<string, unknown> {
    if ((options.rp.id ?? this.rpId) !== this.rpId) {
      throw new Error(`soft authenticator: RP id ${options.rp.id} is not ${this.rpId}`);
    }
    if (!options.pubKeyCredParams.some((p) => p.alg === -7)) throw new Error("soft authenticator: server does not accept ES256");
    for (const ex of options.excludeCredentials ?? []) {
      if (this.credentials.some((c) => c.id.equals(fromB64u(ex.id)))) throw new Error("soft authenticator: InvalidStateError (credential excluded)");
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const id = Buffer.concat([Buffer.from("TESTONLY", "ascii"), crypto.randomBytes(16)]);
    const jwk = publicKey.export({ format: "jwk" });
    const cose = new Map<Cbor, Cbor>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, fromB64u(jwk.x as string)],
      [-3, fromB64u(jwk.y as string)],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x45]), // UP | UV | AT
      Buffer.alloc(4), // signCount 0
      Buffer.alloc(16), // aaguid
      idLen,
      id,
      cbor(cose),
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    this.credentials.push({ id, privateKey, userHandle: fromB64u(options.user.id), rpId: this.rpId, signCount: 0 });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** Sign-in or step-up: returns the JSON the server's verify route takes as `credential`. */
  get(options: PublicKeyRequestOptions): Record<string, unknown> {
    if ((options.rpId ?? this.rpId) !== this.rpId) throw new Error(`soft authenticator: RP id ${options.rpId} is not ${this.rpId}`);
    const allowed = (options.allowCredentials ?? []).map((c) => fromB64u(c.id));
    const cred = [...this.credentials].reverse().find((c) => c.rpId === this.rpId && (allowed.length === 0 || allowed.some((a) => a.equals(c.id))));
    if (!cred) throw new Error("soft authenticator: NotAllowedError (no matching credential)");
    cred.signCount += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(cred.signCount);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), count]); // UP | UV
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey); // DER
    return {
      id: b64u(cred.id),
      rawId: b64u(cred.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: b64u(cred.userHandle),
      },
      clientExtensionResults: {},
    };
  }

  /** Base64url id of the credential made last. */
  get lastCredentialId(): string {
    const c = this.credentials[this.credentials.length - 1];
    if (!c) throw new Error("soft authenticator: no credential yet");
    return b64u(c.id);
  }

  /** The form CDP `WebAuthn.addCredential` takes, so a browser can sign in with a key made here. */
  exportForChromium(cred: SoftCredential = this.credentials[this.credentials.length - 1]!): CdpCredential {
    return {
      credentialId: cred.id.toString("base64"),
      isResidentCredential: true,
      rpId: cred.rpId,
      privateKey: cred.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      userHandle: cred.userHandle.toString("base64"),
      signCount: cred.signCount,
    };
  }
}
