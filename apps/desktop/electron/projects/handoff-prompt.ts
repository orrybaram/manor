/**
 * The first prompt of an Agent a workspace move starts fresh on the new
 * host: what the old Agent's Session was about, so the new one can pick up.
 *
 * A move never writes a CLI's session store (`CONTEXT.md`, **Session**):
 * the new Agent is a new Session, told where the work came from, what was
 * asked first, the last turns, and that the branch holds every commit.
 * Pure, so the text is tested as it is sent.
 */

import { promptTemplate, renderTemplate, type PromptOverrides } from "../../src/lib/prompts/catalog";
import type { PreviewTurn, SessionPreview } from "../sessions/preview";

/** The most recent turns a handoff quotes. */
const RECENT_TURNS = 10;
/** A quoted turn past this is cut. */
const TURN_MAX = 1200;
/** The first prompt past this is cut. */
const FIRST_PROMPT_MAX = 2000;
/** The whole prompt stays under this: the oldest turns go first. */
export const HANDOFF_MAX = 7000;

/** A conversation turn a handoff can quote: the user's or the agent's words. */
export interface HandoffTurn {
  role: "user" | "assistant";
  text: string;
}

export interface HandoffInput {
  sourceHostName: string;
  targetHostName: string;
  branch: string;
  session: { title: string | null; firstPrompt: string | null };
  /** Oldest first. Tool turns are dropped. */
  turns: readonly (HandoffTurn | PreviewTurn)[];
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function quote(turn: HandoffTurn): string {
  const who = turn.role === "user" ? "User" : "Assistant";
  return `${who}: ${clip(turn.text, TURN_MAX)}`;
}

/** The handoff's parts a session may have nothing for. */
const OPTIONAL_PARTS = new Set(["session", "first_prompt", "recent_turns"]);

/** Stands in for a part with nothing to say, until its gap is closed. */
const NOTHING = "\u0000";

/**
 * Render a handoff, closing the gap an optional part with nothing to say would
 * leave: only around those parts, so a quoted turn's own blank lines survive.
 * A NUL in a session's text is dropped, so it can't pass for the marker.
 */
function renderHandoff(template: string, values: Record<string, string>): string {
  const marked = Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const clean = value.split(NOTHING).join("");
      return [name, !clean && OPTIONAL_PARTS.has(name) ? NOTHING : clean];
    }),
  );
  return renderTemplate(template, marked)
    .replace(new RegExp(`\\s*(?:${NOTHING}\\s*)+`, "g"), "\n\n")
    .trim();
}

/** The handoff prompt (see the module header), at most `HANDOFF_MAX` characters. */
export function buildHandoffPrompt(input: HandoffInput, overrides?: PromptOverrides | null): string {
  const { sourceHostName, targetHostName, branch, session } = input;
  const title = session.title?.trim();
  const firstPrompt = session.firstPrompt?.trim();

  const said = input.turns.filter(
    (t): t is HandoffTurn =>
      (t.role === "user" || t.role === "assistant") && t.text.trim().length > 0,
  );
  const quoted = said.slice(-RECENT_TURNS).map(quote);

  // An edit whose every part came up empty still has to say something.
  const edited = promptTemplate("handoff", overrides);
  const compose = (turns: string[]) =>
    renderHandoff(edited, {
      source: sourceHostName,
      target: targetHostName,
      branch,
      session: title ? `Session: ${clip(title, 200)}` : "",
      first_prompt: firstPrompt ? `The session began with:\n${clip(firstPrompt, FIRST_PROMPT_MAX)}` : "",
      recent_turns:
        turns.length > 0
          ? `The last ${turns.length === 1 ? "turn" : `${turns.length} turns`}:\n${turns.join("\n\n")}`
          : "",
    });

  if (!compose(quoted).trim()) return buildHandoffPrompt(input);
  let text = compose(quoted);
  while (text.length > HANDOFF_MAX && quoted.length > 0) {
    quoted.shift();
    text = compose(quoted);
  }
  return text.length > HANDOFF_MAX ? clip(text, HANDOFF_MAX) : text;
}

/**
 * A Session's preview as a handoff's first prompt and turns: the opening
 * prompt (`first`, or the first user turn when the window starts at the
 * beginning) out of the turns, so it is not quoted twice.
 */
export function handoffFromPreview(preview: SessionPreview): {
  firstPrompt: string | null;
  turns: PreviewTurn[];
} {
  const flagged = preview.turns.findIndex((t) => t.role === "user" && t.first === true);
  const at =
    flagged >= 0
      ? flagged
      : preview.truncated
        ? -1
        : preview.turns.findIndex((t) => t.role === "user");
  if (at < 0) return { firstPrompt: null, turns: preview.turns };
  const first = preview.turns[at] as Extract<PreviewTurn, { role: "user" }>;
  return {
    firstPrompt: first.text,
    turns: preview.turns.filter((_, i) => i !== at),
  };
}
