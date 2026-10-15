/**
 * Telling the pane's own shell from a shell running a script (ADR-231 D5).
 *
 * node-pty names the pane's foreground process group by its leader's argv[0],
 * so a `#!/bin/sh` script in the foreground reads as `/bin/sh`, the same as the
 * pane's shell at its prompt. The reconciler takes any shell in the foreground
 * to mean "the agent is gone", so the sampler in `pty-subprocess.ts` reports a
 * script's shell by what it runs instead. The decision lives here, free of the
 * subprocess's globals, so it can be tested.
 */

export const KNOWN_SHELLS: ReadonlySet<string> = new Set(["zsh", "bash", "fish", "sh"]);

/** `/bin/sh` → `sh`, `-zsh` (a login shell) → `zsh`. */
export function processBasename(name: string): string {
  return (name.split("/").pop() ?? name).replace(/^-/, "");
}

/**
 * The script a shell's argv runs, by basename: `sh /x/manor-e2e-agent --session
 * s` → `manor-e2e-agent`, `sh -c "claude --resume x"` → `claude`. Null for an
 * interactive shell (no operand), or when what it runs is itself a shell.
 */
export function shellScriptName(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
      const words = argv[i + 1]?.trim().split(/\s+/) ?? [];
      const command = words[0] === "exec" ? words[1] : words[0];
      return command ? nonShell(processBasename(command)) : null;
    }
    if (arg.startsWith("-") || arg.startsWith("+")) continue;
    return nonShell(processBasename(arg));
  }
  return null;
}

function nonShell(name: string): string | null {
  return name && !KNOWN_SHELLS.has(name) ? name : null;
}

export interface ShellForeground {
  /** The pane's own shell, `ptyProcess.pid`. */
  shellPid: number;
  /** The foreground process group's leader, or null if the lookup failed. */
  leaderPid: number | null;
  /** The leader's argv, or null if the lookup failed. */
  leaderArgs: readonly string[] | null;
  /** An agent found among the leader's descendants, if any. */
  agentBelow: string | null;
}

/**
 * The foreground name to report while a shell leads the pane's foreground:
 * null for the pane's own shell (and whenever a lookup failed, as before
 * ADR-231), otherwise the agent the shell runs, or the script's name.
 */
export function shellForegroundName(f: ShellForeground): string | null {
  if (f.leaderPid === null || f.leaderPid === f.shellPid) return null;
  if (f.agentBelow) return f.agentBelow;
  if (!f.leaderArgs) return null;
  return shellScriptName(f.leaderArgs);
}
