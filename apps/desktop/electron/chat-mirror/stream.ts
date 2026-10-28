/**
 * One tailed transcript: the agent-neutral half of the chat
 * mirror, shared by a pane's own transcript and by each task's.
 *
 * It holds what it reads (the path, the source, the adapter's parser) and
 * how far it has read (the byte offset), and reads through the source in
 * turn. The offset only ever advances by the byte length of complete lines;
 * a partial trailing line is left unconsumed and re-read, with what follows
 * it, once its newline arrives. A source answers a window at a time, so one
 * read loops until it reaches the end of the file; a line too long for a
 * record is stepped over, and its parser told. Reads never overlap, and
 * triggers that land while one is waiting coalesce into it.
 *
 * Everything it finds goes to its owner's `onPush`: each new or updated
 * entry, and the context size whenever that changes.
 */

import type { OversizedRecord, TranscriptAdapter, TranscriptLineParser } from "./adapters/types";
import type { ChatPush } from "./transcript";
import type { TranscriptSource } from "./transcript-source";

/** What a stream reads: one file, in one agent's format, from one host. */
export interface TranscriptTarget {
  path: string;
  adapter: TranscriptAdapter;
  source: TranscriptSource;
}

export interface TranscriptStreamOptions {
  /** Names the stream in a failed read's log line. */
  label: string;
  /** The format it starts in, until `point` says otherwise. */
  adapter: TranscriptAdapter;
  /** A delegated task's transcript, not the pane's own. */
  child?: boolean;
  /** The poll fallback's interval for a source with `watch`. */
  pollIntervalMs: number;
  /** The poll's interval for a source without `watch` (a remote host). */
  unwatchedPollIntervalMs: number;
  /**
   * A new or updated entry, or a new context size. `publish` is false on the
   * first read of a path, which subscribers fetch as history, not as events.
   */
  onPush(push: ChatPush, publish: boolean): void;
  /** The stream forgot everything read: a new path, or the file was rewritten. */
  onReset?(): void;
}

export class TranscriptStream {
  private target: { path: string | null; adapter: TranscriptAdapter; source: TranscriptSource | null };
  private currentParser: TranscriptLineParser;
  /** Bytes of the file consumed: the end of the last complete line. */
  private offset = 0;
  /** The first read of this path is done; later reads publish what they find. */
  private primed = false;
  /** The context size last pushed, or that the history carries. */
  private contextTokens: number | null = null;
  /** Bumped on every reset, so a read or timer from before it is discarded. */
  private currentGeneration = 0;
  /** Why the last read failed; null once one succeeds. */
  readError: string | null = null;
  private unwatch: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** Reads run one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * A read queued behind the running one and not started yet. Every trigger
   * until it starts joins it — the "read again" flag — so a burst of hooks
   * during a slow remote read costs one more read, not one each.
   */
  private pending: Promise<void> | null = null;

  constructor(private readonly opts: TranscriptStreamOptions) {
    this.target = { path: null, adapter: opts.adapter, source: null };
    this.currentParser = this.newParser();
  }

  get path(): string | null {
    return this.target.path;
  }

  get adapter(): TranscriptAdapter {
    return this.target.adapter;
  }

  get source(): TranscriptSource | null {
    return this.target.source;
  }

  get parser(): TranscriptLineParser {
    return this.currentParser;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Point the stream at `target`, or at nothing. The source is taken as is;
   * a different path or format (a different agent kind) starts over, and a
   * stream that was watching, or that `watched` says should be, watches the
   * new path.
   */
  point(target: TranscriptTarget | null, watched: boolean): void {
    if (target) this.target.source = target.source;
    const path = target?.path ?? null;
    const adapter = target?.adapter ?? this.target.adapter;
    if (path === this.target.path && adapter === this.target.adapter) return;
    const watching = this.unwatch !== null || this.poll !== null;
    this.stopWatching();
    this.target.adapter = adapter;
    this.reset(path);
    if (watching || watched) this.startWatching();
  }

  /** Stop, forget everything read, and discard any read in flight. */
  release(): void {
    this.stopWatching();
    this.reset(null);
  }

  startWatching(): void {
    const { path, source } = this.target;
    if (!path || this.poll !== null) return;
    const onChange = () => {
      void this.read();
    };
    this.unwatch = source?.watch?.(path, onChange) ?? null;
    this.poll = setInterval(
      onChange,
      source?.watch ? this.opts.pollIntervalMs : this.opts.unwatchedPollIntervalMs,
    );
    this.poll.unref?.();
    onChange();
  }

  stopWatching(): void {
    this.unwatch?.();
    this.unwatch = null;
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
  }

  /**
   * Read whatever was appended since the last read, in turn. The promise
   * settles after a read that started after this call. A call while a read
   * is already waiting to start joins that one instead of queueing another.
   */
  read(): Promise<void> {
    if (this.pending) return this.pending;
    const run = () => {
      this.pending = null;
      return this.readNow().catch((err: unknown) => {
        console.error(`[chat-mirror] read failed for ${this.opts.label}:`, err);
      });
    };
    const next = this.queue.then(run, run);
    this.pending = next;
    this.queue = next;
    return next;
  }

  /** Forget everything read, and start over at `path`. */
  private reset(path: string | null): void {
    this.opts.onReset?.();
    this.currentGeneration++;
    this.target.path = path;
    this.currentParser = this.newParser();
    this.offset = 0;
    this.primed = false;
    this.contextTokens = null;
    this.readError = null;
  }

  private newParser(): TranscriptLineParser {
    return this.target.adapter.createParser({ child: this.opts.child === true });
  }

  private async readNow(): Promise<void> {
    const { path, source } = this.target;
    if (!path || !source) return;
    let generation = this.currentGeneration;
    for (;;) {
      const result = await source.read(path, this.offset);
      if (generation !== this.currentGeneration) return;
      // Keep what was read so far; the next trigger tries again.
      if (!result.ok) {
        this.readError = result.error;
        return;
      }
      // Rewritten from scratch: start over, quietly (`reset` unprimes, so
      // the re-read publishes nothing). The data read was from the wrong
      // offset, so read again from the start.
      if (result.size < this.offset) {
        this.reset(path);
        generation = this.currentGeneration;
        continue;
      }
      this.readError = null;
      const start = this.offset;
      let reached: number;
      if (result.skip !== undefined && result.skip > 0) {
        // A line too long to read: step over it, and let the parser name it.
        this.oversized(result.skip, { head: result.head ?? "", tail: result.tail ?? "" }, this.primed);
        reached = this.offset;
      } else {
        this.consume(result.data, this.primed);
        reached = start + Buffer.byteLength(result.data, "utf8");
      }
      // A source returns a window at a time: read on until the end, still as
      // one read (and, the first time, all of it history). A read that got
      // nowhere is a line still being written; the next trigger tries again.
      if (reached < result.size && this.offset > start) continue;
      this.pushContextTokens(this.primed);
      this.primed = true;
      return;
    }
  }

  /** Step over the `length`-byte line at the offset; `edges` are its ends. */
  private oversized(length: number, edges: OversizedRecord, publish: boolean): void {
    const at = this.offset;
    this.offset += length;
    for (const entry of this.currentParser.oversized?.(edges, at) ?? []) {
      this.opts.onPush(entry, publish);
    }
  }

  /**
   * Parse every complete line in `data`, which starts at `offset`. The
   * offset advances by the byte length of those lines (newlines included);
   * a partial last line is left for the next read to return whole.
   */
  private consume(data: string, publish: boolean): void {
    const end = data.lastIndexOf("\n");
    if (end === -1) return;
    const complete = data.slice(0, end + 1);
    let start = this.offset;
    this.offset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.slice(0, -1).split("\n")) {
      for (const entry of this.currentParser.push(line, start)) {
        this.opts.onPush(entry, publish);
      }
      start += Buffer.byteLength(line, "utf8") + 1;
    }
  }

  /** Push the context size if it changed since the last push. */
  private pushContextTokens(publish: boolean): void {
    const tokens = this.currentParser.contextTokens();
    if (tokens === this.contextTokens) return;
    this.contextTokens = tokens;
    if (tokens !== null) {
      this.opts.onPush(
        { kind: "usage", id: "usage", ts: new Date().toISOString(), contextTokens: tokens },
        publish,
      );
    }
  }
}
