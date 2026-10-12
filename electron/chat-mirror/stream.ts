/**
 * One tailed transcript (ADR-224 D3): the agent-neutral half of the chat
 * mirror, shared by a pane's own transcript and by each task's.
 *
 * It holds the path, the source, the adapter's parser and the byte offset,
 * and reads through the source in turn. The offset only ever advances by the
 * byte length of complete lines; a partial trailing line is left unconsumed
 * and re-read, with what follows it, once its newline arrives. Reads never
 * overlap, and triggers that land while one is waiting coalesce into it.
 *
 * What it does with a parsed entry is its owner's business (`hooks`): the
 * pane publishes to `chat.entry` and settles pickers, a task's stream
 * publishes to `chat.taskEntry`.
 */

import { claudeAdapter } from "./adapters/claude";
import type { TranscriptAdapter, TranscriptLineParser } from "./adapters/types";
import type { ChatEntry } from "./transcript";
import type { TranscriptSource } from "./transcript-source";

export interface TranscriptStreamHooks {
  /**
   * A new or updated entry. `publish` is false on the first read of a path,
   * which subscribers fetch as history rather than as events.
   */
  onEntry(entry: ChatEntry, publish: boolean): void;
  /** After every batch of complete lines, entries included. */
  onConsumed(publish: boolean): void;
  /** The stream forgot everything read: a new path, or the file was rewritten. */
  onReset(): void;
}

export interface TranscriptStreamOptions {
  /** Names the stream in a failed read's log line. */
  label: string;
  /** A delegated task's transcript, not the pane's own (ADR-224 D3). */
  child?: boolean;
  /** The poll fallback's interval for a source with `watch`. */
  pollIntervalMs: number;
  /** The poll's interval for a source without `watch` (a remote host). */
  unwatchedPollIntervalMs: number;
  hooks: TranscriptStreamHooks;
}

export class TranscriptStream {
  path: string | null = null;
  /**
   * The adapter the parser was built by; a change of agent resets. Starts as
   * Claude's until the owner says otherwise.
   */
  adapter: TranscriptAdapter = claudeAdapter;
  parser: TranscriptLineParser;
  /** Bytes of the file consumed: the end of the last complete line. */
  offset = 0;
  source: TranscriptSource | null = null;
  /** The first read of this path is done; later reads publish what they find. */
  primed = false;
  /** Bumped on every reset, so a read or timer from before it is discarded. */
  generation = 0;
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
    this.parser = this.adapter.createParser(this.parserOptions());
  }

  /** Whether a watcher or poll is running. */
  get watching(): boolean {
    return this.unwatch !== null || this.poll !== null;
  }

  /**
   * Point the stream at `path`, read with `adapter`. A different path or a
   * different agent kind (a different format) starts over; a stream that was
   * watching, or that `watched` says should be, watches the new path.
   * Returns whether anything changed.
   */
  usePath(
    path: string | null,
    adapter: TranscriptAdapter,
    watched: boolean,
  ): boolean {
    if (this.path === path && this.adapter === adapter) return false;
    this.adapter = adapter;
    const watching = this.watching;
    this.stopWatching();
    this.reset(path);
    if (watching || watched) this.startWatching();
    return true;
  }

  /** Forget everything read, and start over at `path`. */
  reset(path: string | null): void {
    this.opts.hooks.onReset();
    this.generation++;
    this.path = path;
    this.parser = this.adapter.createParser(this.parserOptions());
    this.offset = 0;
    this.primed = false;
    this.readError = null;
  }

  startWatching(): void {
    if (!this.path || this.poll !== null) return;
    const onChange = () => {
      void this.read();
    };
    const watchable = typeof this.source?.watch === "function";
    this.unwatch = this.source?.watch?.(this.path, onChange) ?? null;
    this.poll = setInterval(
      onChange,
      watchable ? this.opts.pollIntervalMs : this.opts.unwatchedPollIntervalMs,
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

  private parserOptions(): { child?: boolean } | undefined {
    return this.opts.child ? { child: true } : undefined;
  }

  private async readNow(): Promise<void> {
    const path = this.path;
    const source = this.source;
    if (!path || !source) return;
    let generation = this.generation;
    for (;;) {
      const result = await source.read(path, this.offset);
      if (generation !== this.generation) return;
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
        generation = this.generation;
        continue;
      }
      this.readError = null;
      // A line too long to read: step over it, and read on from after it.
      if (result.skip !== undefined && result.skip > 0) {
        this.offset += result.skip;
        continue;
      }
      this.consume(result.data, this.primed);
      this.primed = true;
      return;
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
    this.offset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.slice(0, -1).split("\n")) {
      for (const entry of this.parser.push(line)) {
        this.opts.hooks.onEntry(entry, publish);
      }
    }
    this.opts.hooks.onConsumed(publish);
  }
}
