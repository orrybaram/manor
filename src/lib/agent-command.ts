/**
 * How an agent's launch line is built, as an import-free leaf module.
 *
 * ZERO imports, for the same reason `home-path.ts` has none: the Electron main
 * process builds this line too now — `POST /agents` opens the tab and queues
 * the command itself rather than asking a window to do it (ADR-179 ticket 11)
 * — and main cannot import renderer modules that reach for Zustand stores or
 * `window`. Renderer code keeps importing `DEFAULT_AGENT_COMMAND` from
 * `agent-defaults.ts` and `escapeShellDoubleQuoted` from `home.ts`, both of
 * which re-export from here.
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
export function escapeShellDoubleQuoted(text: string): string {
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
 * prompt flattened and quoted as its first argument.
 */
export function agentCommandWithPrompt(base: string, prompt?: string): string {
  if (!prompt) return base;
  return `${base} "${escapeShellDoubleQuoted(flattenPrompt(prompt))}"`;
}
