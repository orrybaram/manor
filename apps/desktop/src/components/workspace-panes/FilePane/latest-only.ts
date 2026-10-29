/**
 * Orders overlapping reads of one file: each `begin` supersedes the ones
 * before it, so a slow older read that lands last is recognised and dropped
 * instead of overwriting newer content.
 */
export function createLatestOnly() {
  let latest = 0;
  return {
    /** Start a read; returns its ticket. */
    begin(): number {
      latest += 1;
      return latest;
    },
    /** Whether the read holding `ticket` is still the newest one started. */
    isLatest(ticket: number): boolean {
      return ticket === latest;
    },
  };
}
