/**
 * What a **token tally** asks of each agent kind: where its usage lives,
 * and how many fresh tokens (what the model newly read or wrote, leaving out
 * cache reads) were added since a marker.
 *
 * One reader per agent kind (`token-tally.ts` holds them by kind). Claude's
 * is `claude-usage.ts`, Codex's `codex-usage.ts`, pi's `pi-usage.ts`,
 * opencode's `opencode-usage.ts`.
 */

/**
 * Where one source was last counted. `offset` is the reader's position (a
 * byte offset for a JSONL transcript; a reader may use it for a row cursor).
 * The other fields are optional per-reader state. Persisted as JSON in the
 * tally's marker file, so it holds counts and hashes only: never paths, ids,
 * prompt text or model names.
 */
export interface UsageMarker {
  offset: number;
  /**
   * Recently counted messages, oldest first: a short hash of each id and the
   * fresh tokens already counted for it (Claude: one usage per `message.id`,
   * whose later lines may report more output).
   */
  seen?: [string, number][];
  /**
   * Epoch ms before which usage doesn't count: a source counted from its start
   * may open with history copied from elsewhere (a forked session), dated
   * before the source was created.
   */
  floor?: number;
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
  /**
   * A marker at the source's current end: nothing already there counts.
   * Null when the source can't be read now (opencode without `node:sqlite`,
   * or its database not there): nothing is kept, and the source is first
   * seen again on a later tally.
   */
  markerAtEnd(source: string): Promise<UsageMarker | null>;
  /**
   * The fresh tokens after `marker`, and where the next read starts. Null
   * when the source can't be read now: the marker stays as it was.
   */
  read(marker: UsageMarker, source: string): Promise<UsageRead | null>;
}
