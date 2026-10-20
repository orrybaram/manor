/**
 * The renderer imports the route manifest and the host rewrite,
 * so neither may reach Node or Electron. Walks each module's static imports
 * and asserts the closure is made of `src/lib/workspace-key.ts` and the two
 * modules themselves.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const ALLOWED = new Set([
  "electron/bridge/routes.ts",
  "electron/bridge/host-rewrite.ts",
  "src/lib/workspace-key.ts",
]);

/** Repo-relative files reachable from `entry` by non-type imports. */
function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = fs.readFileSync(path.join(ROOT, entry), "utf-8");
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm),
  ].map((m) => m[1]);
  for (const spec of specifiers) {
    if (!spec.startsWith(".")) {
      seen.add(spec); // A package or `node:` builtin: never allowed.
      continue;
    }
    closure(path.relative(ROOT, path.resolve(ROOT, path.dirname(entry), spec) + ".ts"), seen);
  }
  return seen;
}

describe("modules shared with the renderer", () => {
  it.each(["electron/bridge/routes.ts", "electron/bridge/host-rewrite.ts"])(
    "%s imports nothing outside the shared set",
    (entry) => {
      expect([...closure(entry)].filter((file) => !ALLOWED.has(file))).toEqual([]);
    },
  );
});
