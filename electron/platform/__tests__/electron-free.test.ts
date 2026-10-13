/**
 * The host server bundles these modules with no Electron around (ADR-225 D6).
 * Same check as scripts/build-host-tarball.mjs: a bundle that still imports
 * `electron` would die at load time on a remote host while working fine on the
 * laptop. Vite's SSR build leaves `electron` (and every node_modules package)
 * external, so any import of it shows up in the chunk's imports.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "vite";
import type { Rollup } from "vite";

const ROOT = path.resolve(__dirname, "../../..");
const ENTRIES = [
  "electron/remote-control/relay/connector.ts",
  "electron/remote-control/devices.ts",
  "electron/remote-control/push.ts",
  "electron/remote-control/relay/identity.ts",
  "electron/platform/secret-box.ts",
  // The host server's process entry, and so everything it composes (ADR-225).
  "electron/host-server/index.ts",
];

describe("platform ports", () => {
  it("bundle without importing electron", async () => {
    const result = (await build({
      root: ROOT,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        ssr: true,
        minify: false,
        rollupOptions: {
          input: Object.fromEntries(
            ENTRIES.map((e) => [path.basename(e, ".ts"), path.join(ROOT, e)]),
          ),
        },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];

    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs
      .flatMap((o) => o.output)
      .filter((o): o is Rollup.OutputChunk => o.type === "chunk");
    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect([...chunk.imports, ...chunk.dynamicImports]).not.toContain(
        "electron",
      );
      expect(chunk.code).not.toMatch(/require\(\s*["']electron["']\s*\)/);
      expect(chunk.code).not.toMatch(/from\s+["']electron["']/);
    }
  }, 60_000);
});
