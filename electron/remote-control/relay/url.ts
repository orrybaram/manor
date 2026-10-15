/**
 * Where the relay is (ADR-206), apart from the connector so callers that only
 * need the URL — the hosted Jev client (ADR-211) — don't load `ws` and the
 * Noise channel with it. `connector.ts` re-exports all of this.
 */

/**
 * The production relay: the `manor-relay` Worker's custom domain
 * (`relay/wrangler.toml`). `MANOR_RELAY_URL` overrides it (e.g.
 * `ws://localhost:8787` for `pnpm relay:dev`).
 */
export const DEFAULT_RELAY_URL = "https://relay.manor.sh";

export interface RelayEndpoint {
  /** `https://host[:port]` — where the web app is served and links point. */
  origin: string;
  /** `wss://host[:port]` — where the host socket dials. */
  socketBase: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Parse a relay URL (`https://`, `wss://`, or — for a localhost dev relay
 * only — `http://` / `ws://`) into its origin and socket base. Throws on
 * anything else: an unencrypted remote relay would leak room ids and
 * metadata, even though channel content is end-to-end encrypted.
 */
export function parseRelayUrl(raw: string): RelayEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid relay URL: ${raw}`);
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const insecure = url.protocol === "http:" || url.protocol === "ws:";
  if (!secure && !insecure) {
    throw new Error(`Relay URL must be https:// or wss://, got ${raw}`);
  }
  if (insecure && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `Relay URL must be https:// or wss:// unless it is localhost, got ${raw}`,
    );
  }
  return {
    origin: `${secure ? "https" : "http"}://${url.host}`,
    socketBase: `${secure ? "wss" : "ws"}://${url.host}`,
  };
}

/** `MANOR_RELAY_URL` if set, else `DEFAULT_RELAY_URL`. */
export function resolveRelayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MANOR_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
}

/**
 * The web app on the relay, with no credentials in it: what an already-paired
 * browser opens (`https://<relay>/app/<version>/`).
 */
export function relayAppUrl(origin: string, appVersion: string): string {
  return `${origin}/app/${appVersion}/`;
}

/**
 * A pairing link (ADR-206 D3): the web app, with the room, the Noise static
 * public key and the device's raw token in the fragment, which never reaches
 * the relay. Built by the desktop's controller and by a host server
 * (ADR-225 D3) alike, so a phone pairs with either the same way.
 */
export function relayPairingUrl(link: {
  origin: string;
  appVersion: string;
  roomId: string;
  x25519Pub: string;
  rawToken: string;
}): string {
  return `${relayAppUrl(link.origin, link.appVersion)}#relay=${link.roomId}.${link.x25519Pub}&t=${link.rawToken}`;
}

/**
 * The room, key and token back out of a `relayPairingUrl` link, or null for
 * anything else. What the desktop hands a device for a host it pairs it with
 * (ADR-228 D9): the parts, in the device's own channel, not a link to open.
 */
export function parseRelayPairingUrl(
  url: string,
): { roomId: string; x25519Pub: string; rawToken: string } | null {
  const hash = url.indexOf("#");
  if (hash < 0) return null;
  const params = new URLSearchParams(url.slice(hash + 1));
  const relay = params.get("relay") ?? "";
  const dot = relay.indexOf(".");
  const rawToken = params.get("t") ?? "";
  if (dot <= 0 || dot === relay.length - 1 || rawToken === "") return null;
  return { roomId: relay.slice(0, dot), x25519Pub: relay.slice(dot + 1), rawToken };
}
