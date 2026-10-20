/**
 * The agent CLIs a host can install onto its home volume: the
 * one place that says which ids exist, what they are called, and which npm
 * package and binary each one is. The form's options, the recipe's
 * validation and the `up.sh` install loop all come from this list.
 */

import type { Choice } from "./types";

export interface AgentCli {
  id: string;
  label: string;
  /** The npm package, installed with `npm i -g --prefix ~/.local`. */
  pkg: string;
  /** The binary it puts in `~/.local/bin`. */
  bin: string;
}

export const AGENT_CLIS: readonly AgentCli[] = [
  { id: "claude", label: "Claude Code", pkg: "@anthropic-ai/claude-code", bin: "claude" },
  { id: "codex", label: "Codex", pkg: "@openai/codex", bin: "codex" },
];

/** What a new host installs unless told otherwise. */
export const DEFAULT_AGENTS = "claude";

/** The agents as a `multi` field's options. */
export const AGENT_OPTIONS: Choice[] = AGENT_CLIS.map((a) => ({ value: a.id, label: a.label }));

/**
 * The checked ids of a comma-separated answer, in the list's order; blank
 * means none. Throws on an id that is not in the list.
 */
export function parseAgents(raw: string | undefined): string[] {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const id of ids) {
    if (!AGENT_CLIS.some((a) => a.id === id)) {
      throw new Error(`The agent is not valid: ${JSON.stringify(id)}`);
    }
  }
  return AGENT_CLIS.filter((a) => ids.includes(a.id)).map((a) => a.id);
}

/**
 * The `up.sh` step that installs each agent in `MANOR_AGENTS` that is missing,
 * as the `manor` user through `exec` (the command prefix that runs a command
 * inside the host). A failed install warns and does not fail `up`.
 */
export function agentInstallScript(exec: string): string {
  const cases = AGENT_CLIS.map(
    (a) => `    ${a.id}) label=${JSON.stringify(a.label)}; bin=${a.bin}; pkg=${a.pkg} ;;`,
  ).join("\n");
  return `# The agent CLIs chosen in "Agents to install" go onto the home volume, so
# this runs once and they survive restarts. A failed install is a warning.
for agent in $(printf '%s' "\${MANOR_AGENTS:-}" | tr ',' ' '); do
  case "$agent" in
${cases}
    *) continue ;;
  esac
  if ! ${exec} sh -c 'PATH="$HOME/.local/bin:$PATH"; command -v "$1" >/dev/null 2>&1' sh "$bin" </dev/null; then
    echo "manor-stage: Installing $label" >&2
    if ! ${exec} sh -c 'npm i -g --prefix "$HOME/.local" --no-fund --no-audit --loglevel=error "$1"' sh "$pkg" </dev/null; then
      echo "manor: couldn't install $label; the host works without it. Run: npm i -g --prefix ~/.local $pkg" >&2
    fi
  fi
done
`;
}
