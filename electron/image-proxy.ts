/**
 * Fetch a tracker-hosted image with a credential and hand back a data URL,
 * for `GitHubManager.proxyImage` / `LinearManager.proxyImage`.
 *
 * Redirects are followed by hand so the `Authorization` header is only ever
 * sent to a host `isTrusted` accepts: a hop elsewhere (user-attachments → its
 * signed S3 URL) is fetched bare, whatever the runtime's fetch does with
 * credentials on redirect.
 */

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
/** Bigger images aren't worth a data URL in the renderer's query cache. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ProxyImageOptions {
  url: string;
  authorization: string;
  /** Whether a hop may carry `authorization`; only https URLs are asked. */
  isTrusted: (url: URL) => boolean;
  fetchImpl?: typeof fetch;
}

/** Thrown for a 401/403 from a trusted host, so the caller can drop a stale token. */
export class ImageAuthError extends Error {}

export async function fetchImageDataUrl(
  options: ProxyImageOptions,
): Promise<string> {
  const { authorization, isTrusted, fetchImpl = fetch } = options;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  let target = new URL(options.url);
  for (let hop = 0; ; hop++) {
    const trusted = target.protocol === "https:" && isTrusted(target);
    const res = await fetchImpl(target.href, {
      headers: trusted ? { Authorization: authorization } : {},
      redirect: "manual",
      signal,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect without a location: ${res.status}`);
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      target = new URL(location, target);
      if (target.protocol !== "https:") {
        throw new Error(`Refusing a non-https redirect: ${target.protocol}`);
      }
      continue;
    }

    if (!res.ok) {
      if (trusted && (res.status === 401 || res.status === 403)) {
        throw new ImageAuthError(`Failed to fetch image: ${res.status}`);
      }
      throw new Error(`Failed to fetch image: ${res.status}`);
    }

    const length = Number(res.headers.get("content-length"));
    if (length > MAX_IMAGE_BYTES) throw new Error(`Image too large: ${length} bytes`);

    const bytes = await readCapped(res);
    const contentType = imageContentType(
      res.headers.get("content-type"),
      target.pathname,
      bytes,
    );
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error(`Image too large: over ${MAX_IMAGE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The image type to label the bytes with. `raw.githubusercontent.com` serves
 * every file — an SVG included — as `text/plain`, so a `.svg` path whose
 * bytes look like SVG is taken as one; anything else not `image/*` throws.
 */
export function imageContentType(
  header: string | null,
  pathname: string,
  bytes: Buffer,
): string {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  if (
    /\.svg$/i.test(pathname) &&
    (type === "" || type === "text/plain" || type === "application/octet-stream") &&
    /<svg[\s>]/i.test(bytes.subarray(0, 4096).toString("utf-8"))
  ) {
    return "image/svg+xml";
  }
  throw new Error(`Not an image: ${type || "unknown type"}`);
}
