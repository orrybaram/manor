/**
 * Deciding which queued PTY output a warm-restore snapshot already shows.
 *
 * Reattaching to a live session subscribes to the stream *before* asking for the
 * snapshot — that ordering is what keeps output from falling between the two
 * round trips, at the cost of delivering some of it twice. Each chunk carries
 * its position in the session's output stream and the snapshot carries the
 * position it was serialized at, so the overlap is exactly identifiable.
 */

/** A chunk of PTY output, with its position in the session's stream. */
export interface QueuedOutput {
  data: string;
  /** Absent when the daemon predates sequence numbers. */
  seq?: number;
}

/**
 * The queued output still worth writing once `snapshotSeq`'s screen is on
 * display, in arrival order.
 *
 * Anything not positively known to be covered is kept: dropping output nothing
 * can reconstruct is a worse failure than writing a duplicate, so a missing
 * `snapshotSeq` (fresh session, or an older daemon) keeps everything, and so
 * does a chunk with no `seq` of its own.
 */
export function outputAfterSnapshot(
  queued: readonly QueuedOutput[],
  snapshotSeq: number | null | undefined,
): QueuedOutput[] {
  if (snapshotSeq == null) return [...queued];
  return queued.filter((chunk) => chunk.seq == null || chunk.seq > snapshotSeq);
}
