/**
 * How an agent's launch line is built, as an import-free leaf module.
 *
 * ZERO imports, for the same reason `home-path.ts` has none: the Electron main
 * process builds this line too now — `POST /agents` opens the tab and queues
 * the command itself rather than asking a window to do it (ADR-179 ticket 11)
 * — and main cannot import renderer modules that reach for Zustand stores or
 * `window`. Renderer code keeps importing `DEFAULT_AGENT_COMMAND` from
 * `agent-defaults.ts`, which re-exports from here, and `flattenPrompt` for
 * `review-submit.ts`'s reply line. `escapeShellDoubleQuoted` has no caller
 * outside this file any more — launch lines are only built here (ADR-182
 * ticket 1; `home.ts`'s re-export of it, and `App.tsx`'s hand-rolled line,
 * both went with the old callers) — so it stays unexported rather than kept
 * public on the chance something needs it again.
 *
 * Two builders, since ADR-209: `agentCommandWithPromptFile` is the normal
 * launch line — the prompt waits in a file on the pane's host and the typed
 * line only names it, so it stays far below the tty's canonical line limit
 * (1024 bytes on macOS) however long the prompt is. `agentCommandWithPrompt`
 * inlines the prompt, and is now only the main process's fallback when that
 * file cannot be written on the local host — renderer launches pass the
 * prompt beside the bare command instead.
 *
 * Splitting the constant out also breaks the `agent-defaults → home → harness
 * → agent-defaults` cycle ADR-176's amendment recorded: `harness.ts` wanted
 * nothing from `agent-defaults` except this string.
 */

/** Default agent command used when no project-specific command is configured. */
export const DEFAULT_AGENT_COMMAND = "claude --dangerously-skip-permissions";

/**
 * Escape a prompt for interpolation inside a double-quoted shell argument.
 * The launch line is `<harness> "<escaped prompt>"`, which is how a harness's
 * first turn gets seeded.
 */
function escapeShellDoubleQuoted(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!");
}

/**
 * Flatten a prompt to a single line. Prompts here are typed into an
 * interactive shell or a harness's prompt box, and a bare newline either
 * leaves the shell waiting on a continuation prompt or submits the turn
 * early — so every whitespace run that spans a newline collapses to one
 * space before the text is sent (ADR-176's amendment).
 */
export function flattenPrompt(prompt: string): string {
  return prompt.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The line that starts an agent: the harness command on its own, or with the
 * prompt flattened and quoted as its first argument. Bounded by the tty's
 * canonical line limit when typed into a fresh shell, so it is only the
 * fallback for an agent launch (ADR-209).
 */
export function agentCommandWithPrompt(base: string, prompt?: string): string {
  if (!prompt) return base;
  return `${base} "${escapeShellDoubleQuoted(flattenPrompt(prompt))}"`;
}

/** Quote `text` as one single-quoted shell word (`'` becomes `'\''`). */
function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * The line that starts an agent whose prompt waits in `filePath` on the
 * pane's host (ADR-209): `<harness> "$(cat '<file>'; rm -f '<file>')"`. The
 * shell reads the prompt as the harness's first argument and deletes the
 * file as it does. Not flattened — `"$(…)"` keeps the prompt's newlines, and
 * strips only trailing ones. Needs `$(…)` inside double quotes: bash, zsh,
 * fish ≥ 3.4.
 */
export function agentCommandWithPromptFile(
  base: string,
  filePath: string,
): string {
  const q = shellSingleQuote(filePath);
  return `${base} "$(cat ${q}; rm -f ${q})"`;
}
