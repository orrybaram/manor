/** Claude Code's transcript format, read through `TranscriptParser`. */

import { TranscriptParser } from "../transcript";
import type { TranscriptAdapter } from "./types";

export const claudeAdapter: TranscriptAdapter = {
  createParser: () => new TranscriptParser(),
  childTranscriptPath: () => null,
};
