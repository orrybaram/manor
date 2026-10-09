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
