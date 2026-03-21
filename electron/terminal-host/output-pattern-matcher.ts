/**
 * Output pattern matcher — fallback detection for agent status by scanning
 * terminal output when hook events are unavailable (crash, timeout, non-Claude agent).
 *
 * Maintains a ring buffer of the last 15 lines of ANSI-stripped terminal output
 * and matches patterns to determine agent status.
 */

import type { AgentStatus } from "./types";

const RING_BUFFER_SIZE = 15;

/** Strip ANSI escape sequences from a string */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[hlm]/g, "");
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

// ── Busy patterns ──

const BUSY_STRINGS = [
  "ctrl+c to interrupt",
  "esc to interrupt",
];

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

// ── Requires input patterns ──

const REQUIRES_INPUT_STRINGS = [
  "yes, allow once",
  "no, and tell claude what to do differently",
  "do you trust the files in this folder?",
  "(y/n)",
  "continue?",
  "approve this plan?",
];

function isRequiresInputLine(line: string): boolean {
  const lower = line.toLowerCase();
  for (const s of REQUIRES_INPUT_STRINGS) {
    if (lower.includes(s)) return true;
  }
  return false;
}

// ── Idle pattern ──

/** Check if line is a shell prompt (❯ or > alone on last non-empty line) */
function isIdleLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "❯" || trimmed === ">";
}

export type PatternMatchResult = AgentStatus | null;

export class OutputPatternMatcher {
  private ringBuffer: string[] = [];

  /** Add raw terminal data (may contain multiple lines and ANSI codes) */
  addData(data: string): void {
    const stripped = stripAnsi(data);
    const lines = stripped.split(/\r?\n/);

    for (const line of lines) {
      // Skip empty lines and box-drawing lines
      if (line.trim().length === 0) continue;
      if (isBoxDrawingLine(line)) continue;

      this.ringBuffer.push(line);
      if (this.ringBuffer.length > RING_BUFFER_SIZE) {
        this.ringBuffer.shift();
      }
    }
  }

  /** Scan current buffer and return detected status (or null if unknown) */
  detect(): PatternMatchResult {
    if (this.ringBuffer.length === 0) return null;

    // Check the most recent lines first (last few are most relevant)
    // Scan in reverse so the most recent signal wins
    for (let i = this.ringBuffer.length - 1; i >= Math.max(0, this.ringBuffer.length - 5); i--) {
      const line = this.ringBuffer[i];

      if (isRequiresInputLine(line)) return "requires_input";
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
  }

  /** Get current buffer contents (for debugging) */
  getBuffer(): readonly string[] {
    return this.ringBuffer;
  }
}
