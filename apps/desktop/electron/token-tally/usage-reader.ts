/**
 * What a **token tally** asks of each agent kind: where its usage lives,
 * and how many fresh tokens (what the model newly read or wrote, leaving out
 * cache reads) were added since a marker.
 *
 * One reader per agent kind (`token-tally.ts` holds them by kind). Claude's
 * is `claude-usage.ts`; Codex, pi and opencode plug in the same way.
 */

/**
 * Where one source was last counted. `offset` is the reader's position (a
 * byte offset for a JSONL transcript; a reader may use it for a row cursor).
 * The other fields are optional per-reader state. Persisted as JSON in the
 * tally's marker file, so it holds counts and opaque ids only: never paths,
 * prompt text or model names.
 */
export interface UsageMarker {
  offset: number;
  /** Recently counted message ids (Claude: one usage per `message.id`). */
  ids?: string[];
  /** A cumulative total the source reports (Codex's `total_token_usage`). */
  total?: number;
}

export interface UsageRead {
  /** Fresh tokens added between the marker and `next`. */
  fresh: number;
  next: UsageMarker;
}

export interface UsageReader {
  /**
   * The sources one agent's usage lives in, from its `transcriptPath`
   * (Claude: the transcript and its session's subagent transcripts). A
   * source is what `read` takes and what the marker file keys (hashed).
   */
  sources(transcriptPath: string): Promise<string[]>;
  /** When the source was created, in epoch ms; null when unknown or gone. */
  createdAt(source: string): Promise<number | null>;
  /** A marker at the source's current end: nothing already there counts. */
  markerAtEnd(source: string): Promise<UsageMarker>;
  /** The fresh tokens after `marker`, and where the next read starts. */
  read(marker: UsageMarker, source: string): Promise<UsageRead>;
}
