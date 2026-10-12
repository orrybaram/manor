/**
 * The seam between the agent-neutral mirror (offsets, tailing, sources,
 * watching, pickers) and a transcript format that belongs to one agent
 * (ADR-224 D1). An adapter only has to map its agent's format onto the shared
 * `ChatEntry` union.
 */

import type { ChatEntry, ChatSkill, ChatTaskEntry } from "../transcript";

/** Reads one transcript, a line at a time. */
export interface TranscriptLineParser {
  push(line: string): ChatEntry[];
  entries(): ChatEntry[];
  contextTokens(): number | null;
  skills(): ChatSkill[];
  hasSkillListing(): boolean;
}

export interface TranscriptAdapter {
  /**
   * A fresh line parser for one transcript. `child` marks the transcript of a
   * delegated task rather than the pane's own.
   */
  createParser(opts?: { child?: boolean }): TranscriptLineParser;
  /**
   * Where a task's own transcript lives, given the parent's path and the
   * task entry. Null when the agent writes none, or this task has none.
   */
  childTranscriptPath(parentPath: string, task: ChatTaskEntry): string | null;
}
