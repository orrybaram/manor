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
 *  ✳ is included — Claude Code uses it in completed titles (e.g. "✳ Agent name").
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
 * The OSC 0/2 title parser moved into the Pane facts extractor
 * (`pane-facts.ts`, ADR-184 §3); re-exported for the old `AgentDetector`
 * fallback path until ADR-184 ticket 4 deletes it.
 */
export { OscTitleParser } from "./pane-facts";
