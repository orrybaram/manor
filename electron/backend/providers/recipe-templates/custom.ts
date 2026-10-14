/**
 * A custom recipe's starting point (ADR-229 D8): the Hosts page's "Create
 * recipe folder" writes `recipe.json` and an `up.sh` that says what it must
 * print, into a new `~/.manor/host-recipes/<id>/`, for the user to finish.
 * VMs and sandboxes reached over ssh are recipes of this kind;
 * `docs/hosts/recipes.md` gives the contract and a worked example.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hostRecipesDir } from "../../../paths";
import { recipeDir, writeRecipe, type Recipe } from "../recipes";
import { shortName } from "./types";

const UP = `#!/usr/bin/env bash
# A Manor host recipe's \`up\` (ADR-229 D2). It runs on this computer, with this
# directory as its cwd. Make it idempotent: create the box when it is
# missing, resume it when it is stopped, and print how to reach it.
#
# Stdout is reserved for one JSON object; send everything else to stderr,
# where Manor shows it as progress. For a box with sshd:
#
#   {"schemaVersion": 1,
#    "resource": {"id": "<your provider's id for the box>"},
#    "connection": {"type": "ssh",
#                   "target": {"host": "203.0.113.7", "port": 22, "username": "dev",
#                              "identityFile": "~/.ssh/id_ed25519",
#                              "hostKey": "ssh-ed25519 AAAA..."}}}
#
# Or, for a box with no sshd, an argv that runs one command on it (Manor
# appends \`sh -c <command>\`; kubectl wants a \`--\` before it, docker doesn't):
#
#   {"schemaVersion": 1,
#    "connection": {"type": "exec", "argv": ["docker", "exec", "-i", "my-box"]}}
#   {"schemaVersion": 1,
#    "connection": {"type": "exec", "argv": ["kubectl", "exec", "-i", "my-pod", "--"]}}
#
# Add "stop", "status" and "destroy" scripts to recipe.json to let Manor put
# the box to sleep and delete it. See docs/hosts/recipes.md.
set -euo pipefail
exec 3>&1 1>&2

echo "manor: edit $MANOR_RECIPE_DIR/up.sh to start your host" >&2
exit 1

# When the box is up, print its connection on fd 3 (the real stdout):
# printf '%s\\n' '{"schemaVersion": 1, "connection": {...}}' >&3
`;

/** A recipe id from `name`: lowercase words joined by dashes, or a fresh one. */
function recipeIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? shortName() : slug;
}

/**
 * Write a custom recipe's skeleton for a host named `name`, and answer its
 * id and the file to reveal. Never overwrites: a taken id gets a suffix.
 */
export function createCustomRecipe(
  name: string,
  baseDir: string = hostRecipesDir(),
): { recipeId: string; file: string } {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("A host name is required.");
  const base = recipeIdFor(trimmed);
  let id = base;
  for (let n = 2; fs.existsSync(recipeDir(id, baseDir)); n++) id = `${base}-${n}`;
  const recipe: Recipe = { schemaVersion: 1, id, name: trimmed, up: "./up.sh" };
  const dir = recipeDir(id, baseDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const up = path.join(dir, "up.sh");
    fs.writeFileSync(up, UP, { mode: 0o755 });
    fs.chmodSync(up, 0o755);
    writeRecipe(recipe, baseDir);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { recipeId: id, file: path.join(dir, "recipe.json") };
}
