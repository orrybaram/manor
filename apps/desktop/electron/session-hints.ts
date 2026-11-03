import fs from "node:fs";
import path from "node:path";

import type { PromptOverrides } from "../src/lib/prompts/catalog";

/**
 * The edited SessionStart hints, for `electron/scripts/agent-hook.js`: a script
 * that runs in a pane with no way to ask Manor. A file beside the hook's port
 * file, so a hook finds the one its own server wrote. Written whole, by rename,
 * so a hook never reads half of it; a hint with no entry uses the script's own.
 */
export function writeSessionHints(file: string, overrides: PromptOverrides): void {
  const hints: PromptOverrides = {};
  if (typeof overrides.sessionHint === "string") hints.sessionHint = overrides.sessionHint;
  if (typeof overrides.sessionHintRemote === "string") {
    hints.sessionHintRemote = overrides.sessionHintRemote;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(hints));
    fs.renameSync(temporary, file);
  } catch (err) {
    console.warn(`[session-hints] could not write ${file}:`, err);
  }
}
