/**
 * What a removed host leaves on this machine, and letting go of it
 * (ADR-229 D8). `hosts.remove` forgets the host's record and unregisters it
 * first; this deletes the files Manor kept for it:
 *
 * - its cache (`~/.manor/host-cache/<hostId>.json`, ADR-227 D4) — the
 *   projects, agents and layout shown while it was away;
 * - a recipe host's own `known_hosts` (`~/.manor/ssh/known_hosts.d/<hostId>`,
 *   ADR-229 D2). Its ssh `Host` block lives only in a transport's temporary
 *   config, which went with the transport;
 * - a recipe host's bookkeeping: with the box destroyed, the whole recipe
 *   directory (`recipe.json`, its scripts, their `state.json` and Manor's
 *   `host.json`); with the box kept, only `host.json`'s record of this host,
 *   so the recipe can start a host afresh.
 *
 * Best effort: a file that cannot be deleted is logged, never thrown — the
 * host is already gone from Manor by then.
 */

import * as fs from "node:fs";
import { hostCacheDir, hostCacheFile, hostKnownHostsDir, hostKnownHostsFile, hostRecipesDir } from "../paths";
import { forgetRecipeHostState, recipeDir } from "./providers/recipes";
import type { HostSpec } from "./types";

/** Where the files live. Each defaults to Manor's own directory. For tests. */
export interface HostFileDirs {
  cacheDir?: string;
  knownHostsDir?: string;
  recipesDir?: string;
}

/** Delete `target`, recursively; a failure is logged. */
function remove(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[host-removal] could not delete ${target}:`, err);
  }
}

/**
 * Delete what Manor kept for host `hostId`, reached by `spec`. `destroyed`
 * says its box was destroyed, so a recipe host's directory goes too.
 */
export function forgetHostFiles(
  hostId: string,
  spec: HostSpec,
  opts: { destroyed: boolean },
  dirs: HostFileDirs = {},
): void {
  remove(hostCacheFile(hostId, dirs.cacheDir ?? hostCacheDir()));
  if (spec.kind !== "recipe") return;
  remove(hostKnownHostsFile(hostId, dirs.knownHostsDir ?? hostKnownHostsDir()));
  let dir: string;
  try {
    dir = recipeDir(spec.recipeId, dirs.recipesDir ?? hostRecipesDir());
  } catch (err) {
    console.warn(`[host-removal] ${hostId}'s recipe id is not valid:`, err);
    return;
  }
  if (opts.destroyed) remove(dir);
  else forgetRecipeHostState(dir, hostId);
}
