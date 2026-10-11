/** `href` as an absolute http(s) URL, resolved against `baseUrl`; null for any other scheme. */
export function httpUrl(href: string, baseUrl?: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
