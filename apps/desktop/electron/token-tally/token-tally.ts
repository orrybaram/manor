import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentKind } from "../terminal-host/types";
import { claudeUsageReader } from "./claude-usage";
import type { UsageMarker, UsageReader } from "./usage-reader";

/**
 * The token tally: each agent's fresh tokens, counted into its server's stats
 * store from wherever each of its sources was last counted.
 *
 * Every host server tallies its own agents (`create-manor-server.ts`): after
 * a turn ends, when an agent closes, and on a slow sweep of live agents. The
 * chat mirror can't be the source, as it reads a transcript only while a
 * chat view is subscribed.
 *
 * Markers live in `token-tally.json` next to `stats.json`, keyed by a hash of
 * the source's path, never the path. A restart neither recounts nor loses a
 * turn. There is no backfill: a source first seen here counts from its start
 * only if it was created after the tally first ran on this host
 * (`since`); otherwise from its current end.
 */

/** A marker untouched this long is dropped. */
const PRUNE_AFTER_MS = 35 * 24 * 60 * 60 * 1000;
/** The backstop sweep's period. */
const SWEEP_MS = 60_000;
const SAVE_DEBOUNCE_MS = 500;
/** A marker's `at` is refreshed at most this often when nothing else moved. */
const TOUCH_MS = 24 * 60 * 60 * 1000;

const FILE_NAME = "token-tally.json";

/** What the tally needs of an agent. */
export interface TallyAgent {
  /** The agent's id; with `paneId`, what its last transcript is remembered by. */
  id?: string;
  paneId?: string | null;
  agentKind: AgentKind;
  transcriptPath: string | null;
}

/** Panes (or agents) whose last transcript is remembered, oldest dropped first. */
const MAX_LAST_TRANSCRIPTS = 1000;
/** How far before a new source's creation its usage counts: clocks differ. */
const FLOOR_SLACK_MS = 2000;

interface StoredMarker extends UsageMarker {
  /** Epoch ms the marker was last tallied. */
  at: number;
}

interface PersistedTally {
  version: 1;
  /** Epoch ms the tally first ran on this host. */
  since: number;
  /** Key: hash of the source's path. */
  markers: Record<string, StoredMarker>;
}

export interface TokenTallyOptions {
  dataDir: string;
  /** Adds fresh tokens to the stats store. */
  record: (fresh: number) => void;
  /** The live agents the sweep tallies. */
  liveAgents?: () => readonly TallyAgent[];
  readers?: Partial<Record<AgentKind, UsageReader>>;
  now?: () => number;
}

export class TokenTally {
  private readonly file: string;
  private readonly record: (fresh: number) => void;
  private readonly liveAgents: () => readonly TallyAgent[];
  private readonly readers: Partial<Record<AgentKind, UsageReader>>;
  private readonly now: () => number;
  private readonly since: number;
  private markers: Record<string, StoredMarker>;
  /** Per transcript: the run in flight, and whether another is wanted after it. */
  private readonly running = new Map<string, { again: boolean; done: Promise<void> }>();
  /**
   * Each pane's (or agent's) last transcript tallied, so a switch to a new one
   * (`/clear`, a resume) gives the old one a last read: its final line may
   * have landed after the turn's tally.
   */
  private readonly lastTranscript = new Map<string, { agentKind: AgentKind; transcriptPath: string }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: TokenTallyOptions) {
    this.file = path.join(opts.dataDir, FILE_NAME);
    this.record = opts.record;
    this.liveAgents = opts.liveAgents ?? (() => []);
    this.readers = opts.readers ?? { claude: claudeUsageReader };
    this.now = opts.now ?? Date.now;
    const loaded = this.load();
    this.markers = loaded?.markers ?? {};
    this.since = loaded?.since ?? this.now();
    this.prune();
    // The first run's `since` must survive a restart before any count.
    if (!loaded) this.flushNow();
  }

  /** Starts the backstop sweep over live agents. */
  start(): void {
    if (this.sweepTimer || this.disposed) return;
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** Tallies every live agent once. */
  async sweep(): Promise<void> {
    await Promise.all(this.liveAgents().map((agent) => this.tally(agent)));
  }

  /**
   * Counts the agent's usage since its markers. Reads of one transcript never
   * overlap: a call while one runs asks for one more run after it.
   */
  tally(agent: TallyAgent): Promise<void> {
    const reader = this.readers[agent.agentKind];
    const transcriptPath = agent.transcriptPath;
    if (!reader || !transcriptPath || this.disposed) return Promise.resolve();
    const previous = this.rememberTranscript(agent, transcriptPath);
    if (!previous) return this.tallyTranscript(reader, transcriptPath);
    return Promise.all([
      this.tally(previous),
      this.tallyTranscript(reader, transcriptPath),
    ]).then(() => undefined);
  }

  /**
   * Records `transcriptPath` as the agent's pane's last, and returns the one
   * it replaces, if any, for a final read.
   */
  private rememberTranscript(agent: TallyAgent, transcriptPath: string): TallyAgent | null {
    const owner = agent.paneId ?? agent.id;
    if (!owner) return null;
    const last = this.lastTranscript.get(owner);
    this.lastTranscript.delete(owner);
    this.lastTranscript.set(owner, { agentKind: agent.agentKind, transcriptPath });
    if (this.lastTranscript.size > MAX_LAST_TRANSCRIPTS) {
      const oldest = this.lastTranscript.keys().next().value;
      if (oldest !== undefined) this.lastTranscript.delete(oldest);
    }
    if (!last || last.transcriptPath === transcriptPath) return null;
    return last;
  }

  private tallyTranscript(reader: UsageReader, transcriptPath: string): Promise<void> {
    const inFlight = this.running.get(transcriptPath);
    if (inFlight) {
      inFlight.again = true;
      return inFlight.done;
    }
    const run = { again: false, done: Promise.resolve() };
    run.done = (async () => {
      try {
        do {
          run.again = false;
          await this.tallyOnce(reader, transcriptPath);
        } while (run.again && !this.disposed);
      } catch (error) {
        console.warn("[token-tally] read failed:", error);
      } finally {
        this.running.delete(transcriptPath);
      }
    })();
    this.running.set(transcriptPath, run);
    return run.done;
  }

  private async tallyOnce(reader: UsageReader, transcriptPath: string): Promise<void> {
    let fresh = 0;
    const moved: Record<string, StoredMarker> = {};
    for (const source of await reader.sources(transcriptPath)) {
      const key = sourceKey(source);
      const stored = this.markers[key];
      const marker = stored ?? (await this.firstMarker(reader, source));
      const read = await reader.read(marker, source);
      const now = this.now();
      if (!stored || !sameMarker(stored, read.next) || now - stored.at >= TOUCH_MS) {
        moved[key] = { ...read.next, at: now };
      }
      fresh += read.fresh;
    }
    // Markers and the count move together, or not at all.
    if (this.disposed) return;
    if (Object.keys(moved).length > 0) {
      Object.assign(this.markers, moved);
      this.scheduleSave();
    }
    if (fresh > 0) this.record(fresh);
  }

  /**
   * A source seen for the first time: from its start if it was created
   * after the tally first ran here, else from its end. One created before
   * the prune window may have lost its marker to pruning, so it starts at
   * its end too.
   *
   * One counted from its start gets a floor at its creation: a forked
   * session opens with the original's history, dated before it, and a
   * birth time can be later than a file's first line.
   */
  private async firstMarker(reader: UsageReader, source: string): Promise<UsageMarker> {
    const createdAt = await reader.createdAt(source);
    if (createdAt === null) return reader.markerAtEnd(source);
    if (createdAt >= this.since && this.now() - createdAt < PRUNE_AFTER_MS) {
      return { offset: 0, floor: createdAt - FLOOR_SLACK_MS };
    }
    return reader.markerAtEnd(source);
  }

  /** Writes the markers now, cancelling a pending debounced save. */
  flushNow(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.prune();
    const state: PersistedTally = { version: 1, since: this.since, markers: this.markers };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(state));
    } catch (error) {
      console.warn("[token-tally] could not save markers:", error);
    }
  }

  /**
   * Stops the sweep and saves. A read still in flight neither counts nor
   * moves its markers, so the next start reads it again.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.flushNow();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private prune(): void {
    const cutoff = this.now() - PRUNE_AFTER_MS;
    for (const [key, marker] of Object.entries(this.markers)) {
      if (marker.at < cutoff) delete this.markers[key];
    }
  }

  private load(): PersistedTally | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const { since, markers } = parsed as Partial<PersistedTally>;
    if (typeof since !== "number" || !Number.isFinite(since)) return null;
    const clean: Record<string, StoredMarker> = {};
    if (typeof markers === "object" && markers !== null) {
      for (const [key, marker] of Object.entries(markers)) {
        const sane = sanitizeMarker(marker);
        if (sane) clean[key] = sane;
      }
    }
    return { version: 1, since, markers: clean };
  }
}

/** The marker file's key for a source: a hash, never the path. */
function sourceKey(source: string): string {
  return createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 24);
}

function sameMarker(a: UsageMarker, b: UsageMarker): boolean {
  return (
    a.offset === b.offset &&
    a.total === b.total &&
    a.floor === b.floor &&
    JSON.stringify(a.seen ?? []) === JSON.stringify(b.seen ?? [])
  );
}

function sanitizeMarker(value: unknown): StoredMarker | null {
  if (typeof value !== "object" || value === null) return null;
  const { offset, at, seen, total, floor } = value as Partial<StoredMarker>;
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return {
    offset,
    at,
    ...(Array.isArray(seen) ? { seen: seen.filter(isSeenEntry) } : {}),
    ...(typeof total === "number" && Number.isFinite(total) ? { total } : {}),
    ...(typeof floor === "number" && Number.isFinite(floor) ? { floor } : {}),
  };
}

function isSeenEntry(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}
