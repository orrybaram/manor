/** ADR-202 §2: small helpers the tracker adapters share. */

/** A hex colour from `gh` (no `#`) or Linear (with `#`) as CSS; undefined if unusable. */
export function cssHex(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const hex = color.startsWith("#") ? color.slice(1) : color;
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex) ? `#${hex}` : undefined;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

/** Same task URL, ignoring trailing slashes and case; never true for a blank URL. */
export function sameUrl(a: string, b: string): boolean {
  return a !== "" && b !== "" && normalizeUrl(a) === normalizeUrl(b);
}
