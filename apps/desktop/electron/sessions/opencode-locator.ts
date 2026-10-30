/**
 * Where an opencode session's transcript is: `<db path>#<session id>`.
 *
 * opencode keeps no transcript file per session, only rows in its database,
 * so an opencode **Agent**'s `transcriptPath` names both (Manor's opencode
 * plugin sends it, `../opencode-plugin.ts`). Session ids (`ses_…`) never
 * hold a `#`, so the last one splits it.
 */

const SEPARATOR = "#";

/** The locator for `sessionId` in the database at `db`. */
export function opencodeLocator(db: string, sessionId: string): string {
  return `${db}${SEPARATOR}${sessionId}`;
}

/** A locator's database and session, or null when it is not one. */
export function parseOpencodeLocator(locator: string): { db: string; sessionId: string } | null {
  const at = locator.lastIndexOf(SEPARATOR);
  if (at <= 0 || at === locator.length - 1) return null;
  return { db: locator.slice(0, at), sessionId: locator.slice(at + 1) };
}
