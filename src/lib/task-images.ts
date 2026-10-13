import { parseHttpsUrl } from "./http-url";

/**
 * Where to fetch a GitHub-hosted image from with a token, or null when the
 * URL isn't GitHub's. A `github.com/<owner>/<repo>/blob|raw/<ref>/<path>`
 * link only serves a private file to a browser session, so it is rewritten
 * to `raw.githubusercontent.com`, which takes the token.
 */
export function githubImageFetchUrl(url: string): string | null {
  const parsed = parseHttpsUrl(url);
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
  return parseHttpsUrl(url)?.hostname === "uploads.linear.app";
}
