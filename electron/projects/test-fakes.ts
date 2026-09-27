/**
 * Test helpers for `ProjectManager`'s host resolver (ADR-183): wire a fake
 * git and shell into the `{ git, shell, facts }` it resolves per host.
 */

import { ExecShellBackend } from "../backend/exec-shell";
import { localFacts, posixJoin, type MachineFacts } from "../backend/machine-facts";
import { LOCAL_HOST_ID, type GitBackend, type ShellBackend } from "../backend/types";
import { toDirSlug } from "../branch-name";
import type { ProjectHostResolver } from "./types";

/**
 * A remote machine's facts, answered through a fake `ShellBackend`: its
 * `homeDir`, `test -e` for `exists` and `cat` for `readFile` — the same
 * commands `execFacts` runs.
 */
export function shellFacts(shell: ShellBackend): MachineFacts {
  return {
    platform: async () => "linux",
    uid: async () => 1000,
    homeDir: () => shell.homeDir(),
    kill: async () => {},
    exists: (p) =>
      shell.exec("test", ["-e", p]).then(
        () => true,
        () => false,
      ),
    readFile: (p) => shell.exec("cat", [p]),
    join: posixJoin,
    defaultWorktreeRoot: async (name) =>
      posixJoin(await shell.homeDir(), ".manor", "worktrees", toDirSlug(name)),
  };
}

/**
 * A host resolver over `git` (one backend, or one per host id) and
 * `shell`. This machine answers its facts from `fs`/`os`; every other host
 * answers through `shell` (see `shellFacts`). Without a `shell`, every
 * host runs this machine's shell and facts.
 */
export function hostsOf(
  git: GitBackend | ((hostId: string) => GitBackend),
  shell?: ShellBackend,
): ProjectHostResolver {
  const gitFor = typeof git === "function" ? git : () => git;
  const local = localFacts();
  const remote = shell ? shellFacts(shell) : local;
  const shellBackend = shell ?? new ExecShellBackend();
  return (hostId) => ({
    // Resolved on use, so tests can see which hosts' git was asked for.
    get git() {
      return gitFor(hostId);
    },
    shell: shellBackend,
    facts: hostId === LOCAL_HOST_ID ? local : remote,
  });
}
