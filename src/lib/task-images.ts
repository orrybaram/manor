import type { TaskProvider } from "./tasks";

/**
 * Where to fetch a GitHub-hosted image from with a token, or null when the
 * URL isn't GitHub's. A `github.com/<owner>/<repo>/blob|raw/<ref>/<path>`
 * link only serves a private file to a browser session, so it is rewritten
 * to `raw.githubusercontent.com`, which takes the token.
 */
export function githubImageFetchUrl(url: string): string | null {
  const parsed = httpsUrl(url);
  if (!parsed) return null;
  if (parsed.hostname === "raw.githubusercontent.com") return parsed.href;
  if (parsed.hostname !== "github.com") return null;
  const file = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(parsed.pathname);
  if (file) {
    return `https://raw.githubusercontent.com/${file[1]}/${file[2]}/${file[3]}`;
  }
  return parsed.href;
}

/** Linear's upload host — the only place the Linear token may be sent. */
export function isLinearImageUrl(url: string): boolean {
  return httpsUrl(url)?.hostname === "uploads.linear.app";
}

/**
 * Whether `provider`'s image proxy will take `url`. Anything else loads
 * straight from its URL, without an IPC round trip the proxy would refuse.
 */
export function isTrackerImageUrl(provider: TaskProvider, url: string): boolean {
  return provider === "linear"
    ? isLinearImageUrl(url)
    : githubImageFetchUrl(url) !== null;
}

function httpsUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}
