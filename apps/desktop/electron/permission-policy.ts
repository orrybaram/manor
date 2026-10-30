/**
 * Which web permissions a page gets, decided without Electron so it can be
 * tested on its own. `permissions.ts` installs it on every session.
 *
 * Two kinds of requester:
 *
 * - **Manor's own windows**: a `WebContents` `window.ts` created, while its
 *   frame is still showing the app's renderer. Granted only what the renderer
 *   uses: clipboard read (terminal paste) and write, media (the webview
 *   recorder's tab capture), notifications and fullscreen.
 * - **Everything else**: `<webview>` guests in browser panes, the popup
 *   windows they open, and any other frame. A short list is granted outright;
 *   sensitive permissions ask the user, once per origin until Manor quits;
 *   the rest are denied.
 *
 * Electron grants every permission when no handler is set, so this is
 * deny-by-default: a permission not named here is refused.
 */

export const APP_WINDOW_GRANTED: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "media",
  "notifications",
  "fullscreen",
]);

export const PAGE_GRANTED: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
]);

export const PAGE_PROMPTED: ReadonlySet<string> = new Set([
  "media",
  "geolocation",
  "notifications",
  "clipboard-read",
  "openExternal",
  "local-network-access",
  "local-network",
  "loopback-network",
]);

/** What a permission request carries that the policy reads. */
export interface PermissionAsk {
  permission: string;
  /** The URL of the frame asking; empty when Electron gave none. */
  requestingUrl: string;
  /** For `media`: which devices, e.g. `["audio", "video"]`. */
  mediaTypes?: readonly string[];
  /** For `openExternal`: the link being opened. */
  externalUrl?: string;
}

/** One prompt to show: who asks, and for what, in plain words. */
export interface PromptRequest {
  /** The asking site, as the user knows it (`example.com`). */
  site: string;
  origin: string;
  /** Finishes "<site> wants to …". */
  action: string;
}

/**
 * `R` is whatever identifies the requester (a `WebContents` in the app); the
 * policy only hands it back to these.
 */
export interface PermissionPolicyDeps<R> {
  /** Whether the requester is one of Manor's own windows showing the app. */
  isAppWindow: (requester: R, requestingUrl: string) => boolean;
  /** Ask the user; resolves true for Allow. */
  prompt: (requester: R, request: PromptRequest) => Promise<boolean>;
}

export interface PermissionPolicy<R> {
  /** Answer a permission request, prompting when the policy says to. */
  request(requester: R, ask: PermissionAsk): Promise<boolean>;
  /**
   * Answer a permission check (synchronous: `navigator.permissions.query`,
   * `Notification.permission`, device labels). Never prompts: a prompted
   * permission reads as granted only once the user allowed it.
   */
  check(requester: R, ask: Omit<PermissionAsk, "mediaTypes"> & { mediaType?: string }): boolean;
}

/** The origin of `url`, or null for an opaque one (`data:`, sandboxed `null`). */
function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function siteOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** The scheme of `url` without its colon (`mailto`), or null. */
function schemeOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

const MEDIA_NAMES: Record<string, string> = {
  audio: "your microphone",
  video: "your camera",
};

/**
 * The remembered-answer keys a request needs, and the phrase for its prompt.
 * `media` is split per device, so allowing the microphone doesn't allow the
 * camera; `openExternal` per scheme, so allowing `mailto:` doesn't allow
 * every app link. Null when the request can't be described (deny it).
 */
function describe(
  ask: PermissionAsk,
): { keys: string[]; action: (keys: string[]) => string } | null {
  switch (ask.permission) {
    case "media": {
      const types = (ask.mediaTypes ?? []).filter((t) => t in MEDIA_NAMES);
      if (types.length === 0) return null;
      return {
        keys: types.map((t) => `media:${t}`),
        action: (keys) =>
          `use ${keys.map((k) => MEDIA_NAMES[k.slice("media:".length)]).join(" and ")}`,
      };
    }
    case "openExternal": {
      const scheme = schemeOf(ask.externalUrl);
      if (!scheme) return null;
      return { keys: [`openExternal:${scheme}`], action: () => `open ${scheme}: links in another app` };
    }
    case "geolocation":
      return { keys: ["geolocation"], action: () => "know your location" };
    case "notifications":
      return { keys: ["notifications"], action: () => "show notifications" };
    case "clipboard-read":
      return { keys: ["clipboard-read"], action: () => "see what you copy to the clipboard" };
    case "local-network-access":
    case "local-network":
    case "loopback-network":
      return {
        keys: ["local-network"],
        action: () => "connect to devices and services on your computer and local network",
      };
    default:
      return null;
  }
}

export function createPermissionPolicy<R>(deps: PermissionPolicyDeps<R>): PermissionPolicy<R> {
  /** `${origin} ${key}` → the user's answer, until Manor quits. */
  const answers = new Map<string, boolean>();
  /** The same, for prompts still open: one dialog per question. */
  const pending = new Map<string, Promise<boolean>>();

  async function promptFor(
    requester: R,
    origin: string,
    key: string,
    action: string,
  ): Promise<boolean> {
    const id = `${origin} ${key}`;
    const known = answers.get(id);
    if (known !== undefined) return known;
    let open = pending.get(id);
    if (!open) {
      open = deps
        .prompt(requester, { site: siteOf(origin), origin, action })
        .catch(() => false)
        .then((allowed) => {
          answers.set(id, allowed);
          pending.delete(id);
          return allowed;
        });
      pending.set(id, open);
    }
    return open;
  }

  return {
    async request(requester, ask) {
      if (deps.isAppWindow(requester, ask.requestingUrl)) {
        return APP_WINDOW_GRANTED.has(ask.permission);
      }
      if (PAGE_GRANTED.has(ask.permission)) return true;
      if (!PAGE_PROMPTED.has(ask.permission)) return false;
      const origin = originOf(ask.requestingUrl);
      const described = describe(ask);
      if (!origin || !described) return false;

      // Several devices asked at once (camera + microphone) share one prompt.
      const undecided = described.keys.filter((k) => !answers.has(`${origin} ${k}`));
      if (undecided.length > 0) {
        const allowed = await promptFor(
          requester,
          origin,
          undecided.join("+"),
          described.action(undecided),
        );
        for (const k of undecided) answers.set(`${origin} ${k}`, allowed);
      }
      return described.keys.every((k) => answers.get(`${origin} ${k}`) === true);
    },

    check(requester, ask) {
      if (deps.isAppWindow(requester, ask.requestingUrl)) {
        return APP_WINDOW_GRANTED.has(ask.permission);
      }
      if (PAGE_GRANTED.has(ask.permission)) return true;
      if (!PAGE_PROMPTED.has(ask.permission)) return false;
      const origin = originOf(ask.requestingUrl);
      if (!origin) return false;
      if (ask.permission === "media") {
        const types =
          ask.mediaType && ask.mediaType in MEDIA_NAMES ? [ask.mediaType] : Object.keys(MEDIA_NAMES);
        return types.some((t) => answers.get(`${origin} media:${t}`) === true);
      }
      if (ask.permission === "openExternal") {
        const scheme = schemeOf(ask.externalUrl);
        return scheme !== null && answers.get(`${origin} openExternal:${scheme}`) === true;
      }
      const described = describe({ ...ask, mediaTypes: undefined });
      return (
        described !== null && described.keys.every((k) => answers.get(`${origin} ${k}`) === true)
      );
    },
  };
}
