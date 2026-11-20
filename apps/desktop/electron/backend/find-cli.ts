/**
 * Finding a CLI on a host through its own `ShellBackend`, so the answer is
 * about the box a project lives on, not this machine, and about the PATH
 * its user would see rather than the one a daemon or GUI app inherited.
 */

import { shellQuote } from "../terminal-host/ssh-config";
import type { ShellBackend } from "./types";

/** How long any single host probe (a `command -v`, a login-shell check, …) may run. */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Per-user install folders, under the home directory, that installers add
 * to PATH from an interactive rc file (`.zshrc`, `.bashrc`) a login shell
 * never reads: Claude Code's native installer and most `curl | sh` CLIs
 * (`.local/bin`), OpenCode's installer (`.opencode/bin`), and Claude Code's
 * older local install (`.claude/local`).
 */
const USER_BIN_DIRS = [".local/bin", ".opencode/bin", ".claude/local"] as const;

/**
 * Wrap `snippet` so it runs under the user's own login shell rather than
 * whatever the daemon inherited — a non-interactive ssh command (or an
 * already-running daemon) never sources `.profile`/`.zprofile`, so a CLI
 * installed under `~/.local/bin` or a credential exported there would
 * otherwise look missing. `snippet` is fixed at
 * call sites, never user input, so no quoting beyond `shellQuote` is needed.
 */
function loginShellCommand(snippet: string): string {
  return `exec "\${SHELL:-sh}" -lc ${shellQuote(snippet)}`;
}

/**
 * Resolve `cli` to an absolute path via the host's login shell, falling back
 * to the per-user install folders (`USER_BIN_DIRS`) when the login shell
 * doesn't find it or the probe itself fails to run (odd `$SHELL`, a
 * restrictive rc file). `null` if neither finds it. `cli` is a fixed name
 * from Manor's own lists, never user input.
 */
export async function findCliOnHost(
  shell: ShellBackend,
  cli: string,
): Promise<string | null> {
  try {
    const out = await shell.exec(
      "sh",
      ["-c", loginShellCommand(`command -v ${cli}`)],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const found = out.trim();
    if (found.length > 0) return found;
  } catch {
    // Fall through to the per-user folders below.
  }
  try {
    const home = await shell.homeDir();
    const candidates = USER_BIN_DIRS.map((dir) => shellQuote(`${home}/${dir}/${cli}`));
    const out = await shell.exec(
      "sh",
      [
        "-c",
        `for p in ${candidates.join(" ")}; do if [ -x "$p" ]; then echo "$p"; break; fi; done`,
      ],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const found = out.trim();
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}
