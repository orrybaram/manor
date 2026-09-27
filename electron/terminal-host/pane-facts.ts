/**
 * Pane facts extractor (ADR-184 §3) — the daemon's one source of Status
 * signals for a session.
 *
 * Terminal bytes, OSC 0/2 titles and the foreground process go in; a
 * `PaneFacts` snapshot comes out, and `onChange` fires only when that snapshot
 * actually changed. Nothing here decides an Agent status: output patterns are
 * reported as raw hints with a timestamp, and main's Status reconciler
 * (`electron/agent-status`) weighs them.
 *
 * Pure: no Electron, no Node APIs, no timers. The daemon bundle and the pty
 * subprocess both import it.
 */

import type { AgentKind, OutputHint, PaneFacts } from "./types";

// ── Agent kinds ──

/**
 * The one table of agent CLIs Manor recognises, by process / command name, in
 * match order. Both the foreground-name lookup and the pty subprocess's
 * command-line inspection (`AGENT_COMMAND_PATTERNS`) come from it.
 */
const AGENT_KIND_BY_NAME: ReadonlyArray<readonly [name: string, kind: AgentKind]> = [
  ["claude", "claude"],
  ["opencode", "opencode"],
  ["codex", "codex"],
  ["pi", "pi"],
];

/**
 * Patterns that find a known agent CLI in a process's command line (e.g.
 * `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.mjs`), in
 * match order. Used by `pty-subprocess.ts` when the foreground process is a
 * JS runtime or a version string.
 */
export const AGENT_COMMAND_PATTERNS: ReadonlyArray<readonly [RegExp, AgentKind]> =
  AGENT_KIND_BY_NAME.map(([name, kind]) => [new RegExp(`\\b${name}\\b`, "i"), kind] as const);

/** The Agent kind of a foreground process name, or null for anything else. */
export function agentKindForProcess(name: string): AgentKind | null {
  const base = (name.split("/").pop() ?? name).replace(/^-/, "").toLowerCase();
  for (const [agentName, kind] of AGENT_KIND_BY_NAME) {
    if (base === agentName) return kind;
  }
  return null;
}

// ── OSC 0/2 titles ──

/**
 * Parse OSC 0 and OSC 2 title sequences from terminal data. Stateful across
 * chunks, so a sequence split between two chunks is still found.
 *
 * OSC 0 = ESC ] 0 ; <title> BEL/ST  (set icon name and window title)
 * OSC 2 = ESC ] 2 ; <title> BEL/ST  (set window title)
 */
export class OscTitleParser {
  private buf: number[] = [];
  private inOsc = false;

  /** Parse data and return any titles found, oldest first. */
  parse(data: string): string[] {
    const titles: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const byte = data.charCodeAt(i);

      if (this.inOsc) {
        if (byte === 0x07 || byte === 0x1b) {
          // BEL or ESC terminator (ST = ESC \)
          titles.push(String.fromCharCode(...this.buf));
          this.buf = [];
          this.inOsc = false;
        } else {
          this.buf.push(byte);
          if (this.buf.length > 4096) {
            this.buf = [];
            this.inOsc = false;
          }
        }
      } else if (byte === 0x1b) {
        // ESC
        this.buf = [byte];
      } else if (this.buf.length === 1 && this.buf[0] === 0x1b && byte === 0x5d) {
        // ESC ]
        this.buf.push(byte);
      } else if (this.buf.length === 2) {
        // After ESC ], only '0' or '2' is a title.
        if (byte === 0x30 || byte === 0x32) {
          this.buf.push(byte);
        } else {
          this.buf = [];
        }
      } else if (this.buf.length === 3 && byte === 0x3b) {
        // semicolon after the OSC type number
        this.buf = [];
        this.inOsc = true;
      } else {
        this.buf = [];
      }
    }

    return titles;
  }

  /** Reset parser state */
  reset(): void {
    this.buf = [];
    this.inOsc = false;
  }
}

// ── Output patterns ──

const RING_BUFFER_SIZE = 15;

/** Strip ANSI escape sequences from a string */
export function stripAnsi(str: string): string {
  return str.replace(
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[?]?[0-9;]*[hlm]/g,
    "",
  );
}

/** Check if a line starts with box-drawing characters (skip these) */
function isBoxDrawingLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return false;
  const ch = trimmed.charCodeAt(0);
  // Box-drawing characters: U+2500-U+257F (│├└─ etc.)
  return ch >= 0x2500 && ch <= 0x257f;
}

/** Check if a string contains braille spinner characters (U+2800-U+28FF) */
function hasBrailleChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x2800 && code <= 0x28ff) return true;
  }
  return false;
}

const BUSY_STRINGS = ["ctrl+c to interrupt", "esc to interrupt"];

/** Whimsical action word pattern: word + "..." + "tokens" (e.g. "✢ Cerebrating... (53s, 749 tokens)") */
const WHIMSICAL_PATTERN = /\w+\.{3}.*tokens/i;

function isBusyLine(line: string): boolean {
  const lower = line.toLowerCase();
  for (const s of BUSY_STRINGS) {
    if (lower.includes(s)) return true;
  }
  if (hasBrailleChars(line)) return true;
  if (WHIMSICAL_PATTERN.test(line)) return true;
  return false;
}

const REQUIRES_INPUT_STRINGS = [
  "yes, allow once",
  "no, and tell claude what to do differently",
  "do you trust the files in this folder?",
  "(y/n)",
];

/**
 * Questions that only count as a prompt when the line *ends* with them.
 * Matching these anywhere would fire on ordinary agent prose
 * ("let me know if you want me to continue?").
 */
const REQUIRES_INPUT_SUFFIXES = ["continue?", "approve this plan?"];

function isRequiresInputLine(line: string): boolean {
  const lower = line.toLowerCase();
  for (const s of REQUIRES_INPUT_STRINGS) {
    if (lower.includes(s)) return true;
  }
  const trimmed = lower.trimEnd();
  for (const s of REQUIRES_INPUT_SUFFIXES) {
    if (trimmed.endsWith(s)) return true;
  }
  return false;
}

/** Check if line is a shell prompt (❯ or > alone on last non-empty line) */
function isIdleLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "❯" || trimmed === ">";
}

/**
 * A ring buffer of the last 15 lines of ANSI-stripped terminal output, scanned
 * for output hints.
 *
 * `requires_input` is **edge-triggered**: it is reported only while the
 * matching prompt line is part of the data chunk just fed in. The answered
 * prompt stays in the ring buffer afterwards ("Yes, allow once" is never
 * erased from the transcript), and a level-triggered match would keep
 * re-asserting `requires_input` on every later chunk.
 */
export class OutputPatternMatcher {
  private ringBuffer: string[] = [];

  /** Total lines ever pushed — lets detect() map a buffer index to a global one. */
  private pushedCount = 0;

  /** Value of `pushedCount` before the most recent addData() call. */
  private chunkStart = 0;

  /** Add raw terminal data (may contain multiple lines and ANSI codes) */
  addData(data: string): void {
    const lines = stripAnsi(data).split(/\r?\n/);

    this.chunkStart = this.pushedCount;

    for (const line of lines) {
      // Skip empty lines and box-drawing lines
      if (line.trim().length === 0) continue;
      if (isBoxDrawingLine(line)) continue;

      this.ringBuffer.push(line);
      this.pushedCount++;
      if (this.ringBuffer.length > RING_BUFFER_SIZE) {
        this.ringBuffer.shift();
      }
    }
  }

  /** True when the line at `index` arrived in the most recent addData() call. */
  private isFresh(index: number): boolean {
    const globalIndex = this.pushedCount - (this.ringBuffer.length - index);
    return globalIndex >= this.chunkStart;
  }

  /** Scan the buffer and return the output hint it shows, or null. */
  detect(): OutputHint | null {
    if (this.ringBuffer.length === 0) return null;

    // Scan the most recent lines in reverse so the most recent signal wins.
    for (
      let i = this.ringBuffer.length - 1;
      i >= Math.max(0, this.ringBuffer.length - 5);
      i--
    ) {
      const line = this.ringBuffer[i];

      if (isRequiresInputLine(line)) {
        // Retained from an earlier chunk — the prompt was already reported when
        // it arrived, so don't re-assert it over whatever happened since.
        if (!this.isFresh(i)) continue;
        return "requires_input";
      }
      if (isBusyLine(line)) return "thinking";
    }

    // Check last non-empty line for idle prompt
    const lastLine = this.ringBuffer[this.ringBuffer.length - 1];
    if (isIdleLine(lastLine)) return "idle";

    return null;
  }

  /** Clear the ring buffer */
  clear(): void {
    this.ringBuffer = [];
    this.pushedCount = 0;
    this.chunkStart = 0;
  }

  /** Get current buffer contents (for debugging) */
  getBuffer(): readonly string[] {
    return this.ringBuffer;
  }
}

// ── The extractor ──

export interface PaneFactsExtractorOptions {
  /** Monotonic clock in ms; stamps output hints. Defaults to `performance.now()`. */
  now?: () => number;
  /** Called with the whole new snapshot, only when it changed. */
  onChange?: (facts: PaneFacts) => void;
}

/**
 * One session's Pane facts (ADR-184 §3).
 *
 * Emission rules:
 * - **Foreground**: every change of the foreground process (name or kind)
 *   emits, including back to the shell (`foreground: null`), so the Status
 *   reconciler never keeps a stale snapshot for its liveness rule.
 * - **Title**: the latest OSC 0/2 title of a chunk; emits when it differs from
 *   the last one.
 * - **Output hint**: a *new* hint gets a fresh, strictly increasing `at` and
 *   emits. A hint is new when it differs from the last hint seen, when it is
 *   `requires_input` (edge-triggered: each fresh prompt is its own event), or
 *   when it is the first hint since the foreground process changed (a
 *   restarted agent's first "thinking" must reach the reconciler even if the
 *   last agent's final hint was "thinking" too). Repeats of the same hint —
 *   a spinner redrawing every chunk — do not emit.
 * - Nothing else emits: a snapshot equal to the last one is never sent.
 */
export class PaneFactsExtractor {
  private readonly titleParser = new OscTitleParser();
  private readonly matcher = new OutputPatternMatcher();
  private readonly now: () => number;
  private readonly onChange: ((facts: PaneFacts) => void) | undefined;

  private foreground: PaneFacts["foreground"] = null;
  private title: string | null = null;
  private outputHint: PaneFacts["outputHint"] = null;

  /** The last hint detected since the foreground changed (not necessarily emitted). */
  private lastHint: OutputHint | null = null;
  private lastAt = -Infinity;

  constructor(options: PaneFactsExtractorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.onChange = options.onChange;
  }

  /** The current snapshot. A fresh object each call. */
  get facts(): PaneFacts {
    return {
      foreground: this.foreground ? { ...this.foreground } : null,
      title: this.title,
      outputHint: this.outputHint ? { ...this.outputHint } : null,
    };
  }

  /** Feed a chunk of terminal output (as broadcast on `MSG.DATA`). */
  feedData(data: string): void {
    let changed = false;

    const titles = this.titleParser.parse(data);
    if (titles.length > 0) {
      const latest = titles[titles.length - 1];
      if (latest !== this.title) {
        this.title = latest;
        changed = true;
      }
    }

    this.matcher.addData(data);
    const hint = this.matcher.detect();
    if (hint !== null) {
      const isNew = hint !== this.lastHint || hint === "requires_input";
      this.lastHint = hint;
      if (isNew) {
        this.outputHint = { hint, at: this.stamp() };
        changed = true;
      }
    }

    if (changed) this.emit();
  }

  /**
   * The foreground process changed (from `pty-subprocess`'s polling): its
   * name, or null when the shell is back in the foreground.
   */
  setForeground(name: string | null): void {
    const next = name ? { name, kind: agentKindForProcess(name) } : null;
    const prev = this.foreground;
    if (prev?.name === next?.name && prev?.kind === next?.kind) return;
    this.foreground = next;
    // The next hint is new whatever it is: it belongs to whatever is now running.
    this.lastHint = null;
    this.emit();
  }

  /** A strictly increasing monotonic timestamp for a new output hint. */
  private stamp(): number {
    const now = this.now();
    this.lastAt = now > this.lastAt ? now : this.lastAt + 1;
    return this.lastAt;
  }

  private emit(): void {
    this.onChange?.(this.facts);
  }
}
