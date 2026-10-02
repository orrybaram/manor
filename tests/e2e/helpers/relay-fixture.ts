import fs from "fs";
import os from "os";
import path from "path";

import { test as base } from "../fixtures";
import {
  fakeVersionBuild,
  seedRelayState,
  startLocalRelay,
  type LocalRelay,
} from "./relay";

/**
 * The local Manor relay as Playwright fixtures (ADR-206, ADR-207 D3).
 *
 * The relay is the only road from a browser to the desktop, so every spec
 * that opens the web app runs one: `wrangler dev` on a port of its own
 * (`./relay.ts`), its local R2 seeded with this checkout's
 * `pnpm build:web:relay` output, and the app launched with `MANOR_RELAY_URL`
 * pointing at it — and as the repo root (`asPackage`), so it reports Manor's
 * version, which every pairing link and hello names (ADR-206 D4).
 *
 * Needs Node >= 22 on PATH (wrangler's floor) and `dist-relay-web/`; the
 * e2e package scripts build it before they run.
 */

export interface LocalRelayOptions {
  /**
   * Extra versions to publish beside this checkout's: a copy of the same
   * build rewritten to believe it is that version (`fakeVersionBuild`), for
   * the version-redirect test.
   */
  otherVersions?: string[];
}

/** A `test` whose `app` is launched against a fresh local relay. */
export function withLocalRelay({ otherVersions = [] }: LocalRelayOptions = {}) {
  return base.extend<{ relay: LocalRelay }, { relaySeed: string }>({
    // Uploading a web build is one wrangler process per file, so it happens
    // once per worker; each test gets a fresh copy of the result.
    relaySeed: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const scratch = fs.mkdtempSync(
          path.join(os.tmpdir(), "manor-relay-web-"),
        );
        try {
          const extra = Object.fromEntries(
            otherVersions.map((v) => [v, fakeVersionBuild(v, scratch)]),
          );
          const seed = await seedRelayState(extra);
          try {
            await use(seed);
          } finally {
            fs.rmSync(seed, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      },
      { scope: "worker", timeout: 240_000 },
    ],

    relay: [
      async ({ relaySeed }, use, testInfo) => {
        const relay = await startLocalRelay(relaySeed);
        try {
          await use(relay);
        } finally {
          if (fs.existsSync(relay.logFile)) {
            await testInfo.attach("wrangler.log", {
              path: relay.logFile,
              contentType: "text/plain",
            });
          }
          await relay.dispose();
        }
      },
      // Its own budget: wrangler bundles the Worker before it listens.
      { timeout: 120_000 },
    ],

    appLaunch: async ({ relay }, use) => {
      await use({ env: { MANOR_RELAY_URL: relay.url }, asPackage: true });
    },
  });
}

/** The common case: a local relay with only this checkout's build on it. */
export const relayTest = withLocalRelay();
