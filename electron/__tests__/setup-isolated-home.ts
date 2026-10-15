/**
 * Vitest setup: give every worker a throwaway $HOME before any test module is
 * imported.
 *
 * Everything under `electron/paths.ts` resolves through `os.homedir()`, which
 * honours `$HOME` on POSIX, and `TerminalHostClient` caches `manorHomeDir()`
 * at import time. Without this, a test that exercises real code paths — the
 * `processes:killAll` handler, `AgentHookServer.start()`, `WebviewServer` —
 * reads and writes the developer's live `~/.manor`. On 2026-09-06 that sent
 * SIGTERM to the daemon behind the developer's own Manor window (ADR-169).
 *
 * Dependency-free on purpose: it must work regardless of setupFiles ordering.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The home directory the test process was started with. Never write here. */
export const REAL_HOME = process.env.HOME ?? os.homedir();

const isolatedHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "manor-vitest-home-"),
);
fs.mkdirSync(path.join(isolatedHome, ".manor"), { recursive: true });
process.env.HOME = isolatedHome;

// Tripwire (#310): the default sessions directory (`scrollbackSessionsDir()`,
// `~/.manor/sessions`) is a plain file, so a test that builds a
// `TerminalHost` or `ScrollbackWriter` without its own temp dir fails at once
// with ENOTDIR instead of quietly sharing session files across tests.
fs.writeFileSync(
  path.join(isolatedHome, ".manor", "sessions"),
  "Test tripwire: pass a temp sessions dir to TerminalHost / ScrollbackWriter.\n",
);

process.on("exit", () => {
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    // Best effort — a leftover temp dir is harmless.
  }
});
