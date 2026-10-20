import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

/**
 * A host Manor starts from a recipe, over the remote-host suite's
 * sshd. The recipe's `up` hands back that sshd's address and key
 * as an ssh target, so Manor starts, stops and wakes a "box" that is really
 * the harness's — with the same isolated `$HOME` the ssh host uses.
 *
 * The recipe has no `status`, so Manor reports the state it last stored
 * (`up` after `up`, `sleeping` after `stop`). Don't register this and the
 * ssh host (`APP_TARGET`) in one test.
 */

export interface SshRecipe {
  id: string;
  name: string;
  /** Written into recipe.json; the host stops itself when idle this long. */
  idleStopMinutes?: number;
}

/** The harness's `manor-e2e-direct` block: where `up` points Manor. */
function directTarget(): {
  port: number;
  username: string;
  identityFile: string;
} {
  const config = process.env.MANOR_E2E_SSH_CONFIG;
  if (!config) throw new Error("MANOR_E2E_SSH_CONFIG is not set");
  const lines = fs.readFileSync(config, "utf-8").split("\n");
  const fields: Record<string, string> = {};
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    const host = /^Host\s+(\S+)$/.exec(line);
    if (host) {
      inBlock = host[1] === "manor-e2e-direct";
      continue;
    }
    const field = /^(\w+)\s+(.+)$/.exec(line);
    if (inBlock && field) fields[field[1].toLowerCase()] = field[2];
  }
  const { port, user, identityfile } = fields;
  if (!port || !user || !identityfile) {
    throw new Error(
      `no manor-e2e-direct block with Port, User and IdentityFile in ${config}`,
    );
  }
  return { port: Number(port), username: user, identityFile: identityfile };
}

function recipeDir(tempHome: string, id: string): string {
  return path.join(tempHome, ".manor", "host-recipes", id);
}

/**
 * Write `<tempHome>/.manor/host-recipes/<id>/`: `recipe.json`, an `up.sh`
 * that counts itself in `up-count` and prints the sshd's ssh target, and a
 * `stop.sh` that counts itself in `stop-count`. Both counters sit in the
 * recipe's own folder (`$MANOR_RECIPE_DIR`).
 */
export function writeSshRecipe(
  tempHome: string,
  { id, name, idleStopMinutes }: SshRecipe,
): void {
  const dir = recipeDir(tempHome, id);
  fs.mkdirSync(dir, { recursive: true });
  const recipe = {
    schemaVersion: 1,
    id,
    name,
    up: "./up.sh",
    stop: "./stop.sh",
    ...(idleStopMinutes !== undefined ? { idleStopMinutes } : {}),
  };
  fs.writeFileSync(
    path.join(dir, "recipe.json"),
    JSON.stringify(recipe, null, 2) + "\n",
  );

  const { port, username, identityFile } = directTarget();
  const up = {
    schemaVersion: 1,
    connection: {
      type: "ssh",
      target: {
        host: "127.0.0.1",
        port,
        username,
        identityFile,
        identitiesOnly: true,
      },
    },
  };
  fs.writeFileSync(
    path.join(dir, "up.sh"),
    `#!/bin/sh\necho up >> "$MANOR_RECIPE_DIR/up-count"\ncat <<'JSON'\n${JSON.stringify(up)}\nJSON\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "stop.sh"),
    `#!/bin/sh\necho stop >> "$MANOR_RECIPE_DIR/stop-count"\necho '{}'\n`,
    { mode: 0o755 },
  );
}

function countLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).length;
}

/** How many times Manor has run the recipe's `up`. */
export function upCount(tempHome: string, id: string): number {
  return countLines(path.join(recipeDir(tempHome, id), "up-count"));
}

/** How many times Manor has run the recipe's `stop`. */
export function stopCount(tempHome: string, id: string): number {
  return countLines(path.join(recipeDir(tempHome, id), "stop-count"));
}

/** Register the recipe as a host and start connecting it (runs `up`). Returns the host id. */
export async function addRecipeHost(window: Page, id: string): Promise<string> {
  const { hostId } = await window.evaluate(
    (recipeId) => window.electronAPI.hosts.addRecipeHost(recipeId),
    id,
  );
  return hostId;
}
