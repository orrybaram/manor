/**
 * Jev, provided by Manor through the relay (ADR-211).
 *
 * The TypeSafe key lives on the relay Worker (`relay/src/jev.ts`), which
 * owns the model, question type and instructions; this side sends only the
 * data. Each request is signed with the desktop's relay identity, the same
 * key file remote control uses, so the worker can rate-limit per identity.
 * Loading that store creates the identity on first use; it opens no socket.
 *
 * One attempt, 5 s, no retries here: the worker retries TypeSafe itself, and
 * a suggestion that is late is worth nothing.
 */

import { base64urlEncode, signJevRequest } from "../src/lib/relay-crypto";
import { EncryptionUnavailableError } from "./remote-control/devices";
import { RelayIdentityStore, wipe } from "./remote-control/relay/identity";
import { parseRelayUrl, resolveRelayUrl } from "./remote-control/relay/url";

const REQUEST_TIMEOUT_MS = 5000;

export interface JevQuestion {
  /** Absent fields must be omitted, not `undefined`: the signature covers it. */
  state: Record<string, string>;
  options: Record<string, string>;
}

export interface JevAnswer {
  choice: string;
  confidence: number;
}

export interface JevClientDeps {
  identityStore?: () => RelayIdentityStore;
  /** The relay origin, `https://host[:port]`. */
  baseUrl?: () => string;
  fetch?: typeof fetch;
}

export class JevClient {
  /** Set when `safeStorage` can't encrypt: no identity, so no suggestions this session. */
  private disabled = false;
  private store: RelayIdentityStore | null = null;
  private readonly getStore: () => RelayIdentityStore;
  private readonly baseUrl: () => string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: JevClientDeps = {}) {
    this.getStore =
      deps.identityStore ?? (() => (this.store ??= new RelayIdentityStore()));
    this.baseUrl =
      deps.baseUrl ?? (() => parseRelayUrl(resolveRelayUrl()).origin);
    this.fetchFn = deps.fetch ?? ((...args) => fetch(...args));
  }

  /**
   * Jev's pick among `options` for `state`, or null when there is none to
   * be had (refused, rate-limited, over budget, or a malformed reply).
   * Network and other unexpected errors throw; the bridge handler logs them.
   */
  async suggest({ state, options }: JevQuestion): Promise<JevAnswer | null> {
    if (this.disabled) return null;

    let pub: string;
    let sig: string;
    const ts = Date.now();
    try {
      const identity = this.getStore().load();
      try {
        pub = base64urlEncode(identity.ed25519.pub);
        sig = base64urlEncode(
          signJevRequest(identity.ed25519.priv, ts, { state, options }),
        );
      } finally {
        wipe(identity);
      }
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) {
        this.disabled = true;
        return null;
      }
      throw err;
    }

    const res = await this.fetchFn(`${this.baseUrl()}/jev/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, pub, ts, sig, state, options }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;

    const json = (await res.json()) as {
      choice?: unknown;
      confidence?: unknown;
    } | null;
    const choice = json?.choice;
    const confidence = json?.confidence;
    if (
      typeof choice !== "string" ||
      !Object.prototype.hasOwnProperty.call(options, choice)
    ) {
      return null;
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      return null;
    }
    return { choice, confidence };
  }
}
