/**
 * Title detector — fallback detection for agent status by parsing terminal
 * title set via OSC 0/2 escape sequences.
 *
 * Claude Code sets terminal titles that include braille characters when working
 * and special markers when complete.
 */

import type { AgentStatus } from "./types";

/** Check if a string contains braille spinner characters (U+2800-U+28FF) */
function hasBrailleChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x2800 && code <= 0x28ff) return true;
  }
  return false;
}

/** Done markers that Claude Code puts in titles when finished.
 *  ✳ is included — Claude Code uses it in completed titles (e.g. "✳ Task name").
 *  False positives are prevented because: braille chars are checked first
 *  (so active spinners always return "working"), and setFallbackStatus()
 *  ignores the signal when no agent is being tracked. */
const DONE_MARKERS = ["✳", "✻", "✽", "✶", "✢"];

function hasDoneMarker(str: string): boolean {
  for (const marker of DONE_MARKERS) {
    if (str.includes(marker)) return true;
  }
  return false;
}

export type TitleDetectResult = AgentStatus | "unknown";

export class TitleDetector {
  private currentTitle: string = "";

  /** Update the detected title */
  setTitle(title: string): void {
    this.currentTitle = title;
  }

  /** Get current title */
  getTitle(): string {
    return this.currentTitle;
  }

  /** Detect status from current title */
  detect(): TitleDetectResult {
    if (!this.currentTitle) return "unknown";

    if (hasBrailleChars(this.currentTitle)) return "working";
    if (hasDoneMarker(this.currentTitle)) return "complete";

    return "unknown";
  }
}

/**
 * Parse OSC 0 and OSC 2 title sequences from terminal data.
 * Returns the title string if found, or null.
 *
 * OSC 0 = ESC ] 0 ; <title> BEL/ST  (set icon name and window title)
 * OSC 2 = ESC ] 2 ; <title> BEL/ST  (set window title)
 */
export class OscTitleParser {
  private buf: number[] = [];
  private inOsc = false;
  private oscType: number | null = null;

  /** Parse data and return any titles found */
  parse(data: string): string[] {
    const titles: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const byte = data.charCodeAt(i);

      if (this.inOsc) {
        if (byte === 0x07 || byte === 0x1b) {
          // BEL or ESC terminator (ST = ESC \)
          const title = String.fromCharCode(...this.buf);
          titles.push(title);
          this.buf = [];
          this.inOsc = false;
          this.oscType = null;
        } else {
          this.buf.push(byte);
          if (this.buf.length > 4096) {
            this.buf = [];
            this.inOsc = false;
            this.oscType = null;
          }
        }
      } else if (byte === 0x1b) {
        // ESC
        this.buf = [byte];
      } else if (this.buf.length === 1 && this.buf[0] === 0x1b && byte === 0x5d) {
        // ESC ]
        this.buf.push(byte);
      } else if (this.buf.length === 2) {
        // After ESC ], check for 0 or 2
        if (byte === 0x30 || byte === 0x32) {
          // '0' or '2'
          this.oscType = byte - 0x30;
          this.buf.push(byte);
        } else {
          this.buf = [];
        }
      } else if (this.buf.length === 3 && byte === 0x3b) {
        // semicolon after OSC type number
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
    this.oscType = null;
  }
}
