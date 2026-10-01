/**
 * The Manor relay Worker (ADR-206 D1). Routes socket upgrades to the room
 * Durable Object named by the room id; everything else is 404.
 *
 *   GET /host/<roomId>  the desktop (authenticates inside the room)
 *   GET /join/<roomId>  a viewer
 *
 * Both socket routes are rate-limited per client IP before the upgrade (one
 * limiter, keyed `join:<ip>` / `host:<ip>` so they count separately).
 *   GET /app/<version>/*  the per-version web app, from R2 (ADR-206 D4)
 */
import {
  WEB_CSP,
  webCacheControl,
  webContentType,
} from "../../src/lib/web-headers";
import type { Env } from "./env";

export { Room } from "./room";

/** 22 base64url characters: `roomIdFor` in `src/lib/relay-crypto/keys.ts`. */
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ROUTE_PATTERN = /^\/(host|join)\/([^/]+)$/;

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Semver: 1.2.3, 1.2.3-beta.1, 1.2.3+build.5, 1.2.3-rc.1+sha.abc. Anything a
 * desktop can put in its hello's `appVersion` and the page will redirect to
 * (`src/bridge/web-pairing.ts`) must pass here, or the redirect lands on a
 * bare 404 instead of the "not published" page. No dots-only or slash tricks.
 */
const VERSION_PATTERN =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,40})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,40})?$/;

const SECURITY_HEADERS = {
  "Content-Security-Policy": WEB_CSP,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const UNPUBLISHED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Manor</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<p>This Manor version's web app isn't published. Update Manor, or use Tailscale.</p>
</body></html>`;

/**
 * Resolve the R2 key suffix for the part of the path after the version, or
 * null if it is unsafe. Each segment is decoded and then checked, so `%2e%2e`
 * and `%2f` variants are rejected the same as the literal forms.
 */
function safeRest(rest: string): string | null {
  if (rest === "") return "web.html";
  const segments = rest.split("/");
  if (segments[segments.length - 1] === "") segments.pop();
  const out: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === ".." || /[\\/\0]/.test(seg)) {
      return null;
    }
    out.push(seg);
  }
  return out.length === 0 ? "web.html" : out.join("/");
}

async function serveWebApp(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method not allowed");
  }
  const parts = pathname.slice("/app/".length).split("/");
  const version = parts[0] ?? "";
  if (!VERSION_PATTERN.test(version)) return plain(404, "Not found");
  const file = safeRest(parts.slice(1).join("/"));
  if (file === null) return plain(404, "Not found");

  const object = await env.WEB.get(`app/${version}/${file}`);
  if (!object) {
    // Distinguish "this version was never published" from a bad file path.
    if (!(await env.WEB.head(`app/${version}/web.html`))) {
      return new Response(UNPUBLISHED_PAGE, {
        status: 404,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        },
      });
    }
    return plain(404, "Not found");
  }

  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": webContentType(file),
      "Cache-Control": webCacheControl(file),
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      return serveWebApp(request, env, url.pathname);
    }

    const route = ROUTE_PATTERN.exec(url.pathname);
    if (!route || request.method !== "GET") return plain(404, "Not found");
    const [, kind, roomId] = route;
    if (!ROOM_ID_PATTERN.test(roomId)) return plain(404, "Not found");

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return plain(426, "Expected a WebSocket upgrade");
    }

    // `/host` too: an unauthenticated host socket costs the room a challenge,
    // an alarm and a slot in every scan until its deadline.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.JOIN_LIMITER.limit({ key: `${kind}:${ip}` });
    if (!success) return plain(429, "Too many requests");

    const room = env.ROOM.get(env.ROOM.idFromName(roomId));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
