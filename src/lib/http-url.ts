/** `href` parsed as an absolute http(s) URL, resolved against `baseUrl`; null for any other scheme. */
export function parseHttpUrl(href: string, baseUrl?: string): URL | null {
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** `href` parsed as an absolute https URL; null for plain http or any other scheme. */
export function parseHttpsUrl(href: string): URL | null {
  const url = parseHttpUrl(href);
  return url?.protocol === "https:" ? url : null;
}

/** `href` as an absolute http(s) URL, resolved against `baseUrl`; null for any other scheme. */
export function httpUrl(href: string, baseUrl?: string): string | null {
  return parseHttpUrl(href, baseUrl)?.href ?? null;
}
