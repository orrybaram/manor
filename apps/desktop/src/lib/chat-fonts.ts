/**
 * The fonts chat can be drawn in. Manor ships these (`chat-fonts.css`), so one
 * looks the same on every computer and on a paired phone.
 */

const SYSTEM_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

/** Each bundled family's fallback, used for characters it lacks. */
const BUNDLED_FALLBACK: Record<string, string> = {
  Inter: SYSTEM_SANS,
  Literata: "Georgia, serif",
  "Atkinson Hyperlegible Next": SYSTEM_SANS,
  "IBM Plex Sans": SYSTEM_SANS,
  "JetBrains Mono": "var(--font-mono)",
};

/** The bundled families, in the order the picker lists them. */
export const BUNDLED_CHAT_FONTS = Object.keys(BUNDLED_FALLBACK);

/**
 * The CSS stack for a chat font preference. Empty means the system font the
 * app is drawn in. A family only installed on the computer falls back to the
 * system font on a phone that lacks it.
 */
export function chatFontStack(family: string): string {
  const name = family.replace(/["\\]/g, "").trim();
  if (!name) return "inherit";
  return `"${name}", ${BUNDLED_FALLBACK[name] ?? SYSTEM_SANS}`;
}
