import { createHash, generateKeyPairSync, randomBytes, sign } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import WebSocket from "ws";

import { SETTLE_MS } from "../../src/hooks/useTerminalResize";
import {
  OP_DATA,
  OP_OPEN,
  RELAY_HEADER_BYTES,
} from "../../src/lib/relay-crypto/protocol";
import {
  createWorkspace,
  expect,
  importSeededProject,
  openTerminalTab,
  test as base,
} from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import { readSessionMeta } from "./helpers/local-api";
import { openClient, type Client } from "./helpers/phone";
import {
  appVersion,
  fakeVersionBuild,
  findReadable,
  readableForms,
  seedRelayState,
  startLocalRelay,
  type LocalRelay,
} from "./helpers/relay";
import {
  closeSettings,
  enableRemoteControl,
  pairDeviceViaRelay,
  revokeDevice,
  startRelay,
  stopRelay,
} from "./helpers/settings";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
  scrollback,
} from "./helpers/terminal";

/**
 * ADR-206 end to end: a browser reaches Manor through the relay with nothing
 * but a link, drives a live terminal, and the relay never sees anything it
 * could read.
 *
 * The relay is the real Worker under `wrangler dev` (`helpers/relay.ts`), on
 * its own port with its own persist directory, its local R2 holding this
 * checkout's `pnpm build:web:relay` output. The app is pointed at it with
 * `MANOR_RELAY_URL`, and everything else is the product: remote control is
 * enabled, the relay started and the device paired through Settings, and the
 * browser is an ordinary Playwright page opened on the pairing link.
 *
 * **Blindness.** The relay runs with its dev payload log on (`relay/src/room.ts`,
 * `devPayloadLogEnabled`: a var only `wrangler dev --var` sets, and only for
 * requests addressed to loopback), so every payload it forwarded is in
 * wrangler's output. The marker typed into the terminal and the device
 * token must appear in none of them — not as text, not as hex, not as
 * base64. The first test is the control that makes that meaningful: the
 * same log, fed plaintext on purpose, does find it.
 *
 * Needs Node >= 22 on PATH (wrangler's floor) and `pnpm build:web:relay`;
 * `pnpm test:e2e:relay` builds both the app and the relay web build first.
 */

/** A version that is published in the local R2 but is not the desktop's. */
const OTHER_VERSION = "0.0.1-relay-e2e";

/** Mirrors `WEB_RELAY_KEY` in `src/bridge/web-pairing.ts`. */
const WEB_RELAY_KEY = "manor.web.relay";

const PROJECT_NAME = "test-project";

const test = base.extend<{ relay: LocalRelay }, { relaySeed: string }>({
  // Uploading a web build is one wrangler process per file, so it happens
  // once per run; each test gets a fresh copy of the result.
  relaySeed: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const scratch = fs.mkdtempSync(
        path.join(os.tmpdir(), "manor-relay-web-"),
      );
      try {
        const other = fakeVersionBuild(OTHER_VERSION, scratch);
        const seed = await seedRelayState({ [OTHER_VERSION]: other });
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

/**
 * A pane's whole grid, read off the terminal itself — xterm draws into a
 * canvas. Same seam `web-app.spec.ts` uses: `window.__manorTerminals`.
 */
async function paneText(page: Page, paneId: string): Promise<string> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) return "";
    return handle.serialize({ scrollback: 20_000 });
  }, paneId);
}

/**
 * The desktop reports the version the relay has a build for. It names that
 * version in every relay link and hello (ADR-206 D4), so if the harness
 * launched it some way that reports Electron's own version instead
 * (`LaunchOptions.asPackage`), every later step would fail somewhere far
 * less obvious than here.
 */
async function expectDesktopVersion(app: ElectronApplication): Promise<void> {
  expect(
    await app.evaluate(({ app: electronApp }) => electronApp.getVersion()),
  ).toBe(appVersion());
}

/** The relay web app at a PC viewport, opened on a pairing link. */
function openRelayWebApp(link: string): Promise<Client> {
  return openClient(link, { viewport: { width: 1280, height: 800 } });
}

/** The project header the web app shows once it is through to the desktop. */
function projectHeader(page: Page) {
  return page.getByTestId("project-header").filter({ hasText: PROJECT_NAME });
}

/** A marker that exists nowhere until this test types it. */
function newMarker(): string {
  return `relay-e2e-${randomBytes(8).toString("hex")}`;
}

/** Messages off a `ws` socket, one at a time. */
function queue(socket: WebSocket): () => Promise<Buffer> {
  const items: Buffer[] = [];
  const waiters: Array<(b: Buffer) => void> = [];
  socket.on("message", (data: Buffer) => {
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else items.push(data);
  });
  return () => {
    const next = items.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

test.describe("relay (ADR-206)", () => {
  /**
   * The control for the blindness check below. A host and a viewer that do
   * *not* encrypt — raw sockets speaking only the relay's framing — push a
   * plaintext canary through the local relay, and the payload log must show
   * it, in both directions. If this fails, the log is not capturing what the
   * room forwards, and "the marker is in none of the payloads" would pass for
   * a log that is simply empty.
   *
   * Also pins what the fixture seeded: this build and the other version are
   * both published, and a version that was never uploaded gets the stated
   * page rather than a blank one.
   */
  test("the local relay serves both seeded versions, and its payload log sees plaintext when there is plaintext", async ({
    relay,
  }) => {
    const version = appVersion();
    const current = await fetch(`${relay.url}/app/${version}/`);
    expect(current.status).toBe(200);
    expect(await current.text()).toContain(`/app/${version}/assets/`);

    const other = await fetch(`${relay.url}/app/${OTHER_VERSION}/`);
    expect(other.status).toBe(200);
    expect(await other.text()).toContain(`/app/${OTHER_VERSION}/assets/`);

    const missing = await fetch(`${relay.url}/app/9.9.9/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("isn't published");

    // A host identity, the way the desktop makes one: an Ed25519 key whose
    // hash names the room, signing `"manor-relay-host-v1" ‖ roomId ‖ challenge`.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = Buffer.from(
      publicKey.export({ format: "jwk" }).x as string,
      "base64url",
    );
    const roomId = createHash("sha256")
      .update(pub)
      .digest("base64url")
      .slice(0, 22);
    const wsBase = relay.url.replace(/^http/, "ws");

    const host = new WebSocket(`${wsBase}/host/${roomId}`);
    const hostNext = queue(host);
    await opened(host);
    const challenge = JSON.parse((await hostNext()).toString()) as {
      t: string;
      c: string;
    };
    expect(challenge.t).toBe("challenge");
    const signature = sign(
      null,
      Buffer.concat([
        Buffer.from("manor-relay-host-v1"),
        Buffer.from(roomId),
        Buffer.from(challenge.c, "base64url"),
      ]),
      privateKey,
    );
    host.send(
      JSON.stringify({
        t: "auth",
        pub: pub.toString("base64url"),
        sig: signature.toString("base64url"),
      }),
    );
    expect(JSON.parse((await hostNext()).toString())).toEqual({ t: "ok" });

    const viewer = new WebSocket(`${wsBase}/join/${roomId}`);
    const viewerNext = queue(viewer);
    await opened(viewer);
    const open = await hostNext();
    expect(open[0]).toBe(OP_OPEN);
    const ch = (open[1] << 8) | open[2];

    const up = newMarker();
    const down = newMarker();
    viewer.send(Buffer.from(`plaintext ${up} on purpose`));
    const forwarded = await hostNext();
    expect(forwarded[0]).toBe(OP_DATA);
    expect(forwarded.subarray(RELAY_HEADER_BYTES).toString()).toContain(up);

    host.send(
      Buffer.concat([
        Buffer.from([OP_DATA, ch >> 8, ch & 0xff]),
        Buffer.from(`plaintext ${down} on purpose`),
      ]),
    );
    expect((await viewerNext()).toString()).toContain(down);

    viewer.close();
    host.close();

    // console.log in the room reaches wrangler's stdout asynchronously.
    await expect
      .poll(() => findReadable(relay.payloads(), [up])?.payload.direction, {
        timeout: 10_000,
      })
      .toBe("viewer->host");
    await expect
      .poll(() => findReadable(relay.payloads(), [down])?.payload.direction, {
        timeout: 10_000,
      })
      .toBe("host->viewer");
    // And the encodings the e2e test looks for really are found, so a
    // marker that crossed as base64 or hex would not slip by.
    const asBase64 = Buffer.from(`xx${up}yy`).toString("base64");
    expect(readableForms(up).some((form) => asBase64.includes(form))).toBe(
      true,
    );

    // The relay process can go away and come back on the same port with the
    // same state — the main test leans on this — and the log keeps what it
    // had.
    const before = relay.payloads().length;
    await relay.stop();
    await expect(fetch(`${relay.url}/app/${version}/`)).rejects.toThrow();
    await relay.start();
    expect((await fetch(`${relay.url}/app/${version}/`)).status).toBe(200);
    expect(relay.payloads().length).toBe(before);
  });

  test("a browser pairs through the relay, drives a live terminal, and the relay sees none of it", async ({
    app,
    window,
    tempHome,
    request,
    relay,
  }) => {
    test.setTimeout(300_000);
    const film = new Filmstrip("relay");
    await expectDesktopVersion(app);

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "relay-e2e");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    const { cols: colsBefore } = await readSessionMeta(
      request,
      tempHome,
      paneId,
    );
    expect(colsBefore).not.toBeNull();

    await enableRemoteControl(window);
    await startRelay(window);
    await film.shot(window, "settings-relay-running");
    const device = await pairDeviceViaRelay(window, {
      label: "relay browser",
      film,
    });
    // The link names the relay, this version, the room and key, and the
    // token — all of it after `#`, which no browser sends to a server.
    const link = new URL(device.link);
    expect(link.origin).toBe(relay.url);
    expect(link.pathname).toBe(`/app/${appVersion()}/`);
    expect(link.hash).toMatch(/^#relay=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+&t=/);
    expect(link.hash).toContain(device.token);
    await closeSettings(window);

    // Typed into the terminal from the browser, one per leg of the test;
    // the blindness check at the end looks for every one of them.
    const marker = newMarker();
    const afterRestart = newMarker();
    const afterProcessRestart = newMarker();
    const client = await openRelayWebApp(device.link);
    try {
      // 1. Through to the desktop: the sidebar is the desktop's, the pane is
      // the one the desktop has open, and the fragment is gone from the URL.
      await expect(projectHeader(client.page)).toBeVisible({ timeout: 45_000 });
      expect(new URL(client.page.url()).hash).toBe("");
      expect(await activePaneId(client.page)).toBe(paneId);
      await film.shot(client.page, "browser-through-the-relay");

      // 2. A live terminal, driven from the browser. The marker comes back as
      // the shell's output, so it crossed the relay both ways: typed up as
      // keystrokes, echoed and printed down as pty output.
      await runInTerminal(client.page, `echo ${marker}`);
      await expect
        .poll(() => scrollback(tempHome, paneId), { timeout: 20_000 })
        .toContain(marker);
      await expect
        .poll(() => paneText(client.page, paneId), { timeout: 20_000 })
        .toContain(`echo ${marker}`);
      await expect
        .poll(
          async () =>
            (await paneText(client.page, paneId)).split(marker).length - 1,
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => paneText(window, paneId), { timeout: 20_000 })
        .toContain(marker);
      await film.shot(client.page, "browser-terminal-marker");

      // 3. The desktop owns the winsize (follower rule): a narrower browser
      // scales its glyphs and leaves the session's grid alone.
      await client.page.setViewportSize({ width: 700, height: 800 });
      await client.page.waitForTimeout(SETTLE_MS + 600);
      expect((await readSessionMeta(request, tempHome, paneId)).cols).toBe(
        colsBefore,
      );
      await expect(client.page.getByTestId("terminal-follower")).toBeVisible();
      await film.shot(client.page, "browser-follower");

      // 4. Stopping the relay from Settings: the room has no host, says 4404,
      // and the page says "not reachable" over the app, not a frozen app.
      const unreachable = client.page.getByTestId("web-app-unreachable");
      await stopRelay(window);
      await expect(unreachable).toBeVisible({ timeout: 30_000 });
      await film.shot(client.page, "browser-not-reachable");

      // Starting it again: the browser finds its way back on its own — no
      // click on "Try again now", no reload.
      await startRelay(window);
      await closeSettings(window);
      await expect(unreachable).toHaveCount(0, { timeout: 60_000 });
      await expect(projectHeader(client.page)).toBeVisible();
      await runInTerminal(client.page, `echo ${afterRestart}`);
      await expect
        .poll(() => scrollback(tempHome, paneId), { timeout: 20_000 })
        .toContain(afterRestart);
      await film.shot(client.page, "browser-back-after-relay-restart");

      // 5. The relay itself goes away and comes back (the process, not the
      // setting): both ends dial it again with their own backoff, and the
      // terminal works again without anyone touching either of them.
      await relay.stop();
      await relay.start();
      // Typed until it lands: keystrokes sent while the bridge is still
      // redialling are dropped, not queued, so one attempt could miss.
      await expect
        .poll(
          async () => {
            if (scrollback(tempHome, paneId).includes(afterProcessRestart)) {
              return true;
            }
            if (await unreachable.isVisible()) return false;
            await runInTerminal(client.page, `echo ${afterProcessRestart}`);
            return false;
          },
          { timeout: 90_000, intervals: [3_000] },
        )
        .toBe(true);
      await expect(unreachable).toHaveCount(0);
      await film.shot(client.page, "browser-back-after-process-restart");

      // 6. Revoking the device closes its live channel with 4401, which the
      // relay passes through: the page forgets the pairing and says so,
      // without waiting for its next request.
      await revokeDevice(window, device.label);
      await expect(client.page.getByTestId("web-app-no-token")).toBeVisible({
        timeout: 30_000,
      });
      expect(
        await client.page.evaluate(
          (key) => localStorage.getItem(key),
          WEB_RELAY_KEY,
        ),
      ).toBeNull();
      await film.shot(client.page, "browser-revoked");
    } finally {
      film.write("browser-console.log", client.log.join("\n") + "\n");
      await client.close();
    }

    // 7. Blindness, over everything the relay forwarded in this test: the
    // handshakes, the hello carrying the token, every keystroke and every
    // byte of output — before and after both restarts.
    const payloads = relay.payloads();
    expect(
      payloads.filter((p) => p.direction === "viewer->host").length,
    ).toBeGreaterThan(10);
    expect(
      payloads.filter((p) => p.direction === "host->viewer").length,
    ).toBeGreaterThan(10);
    const secrets = [marker, afterRestart, afterProcessRestart, device.token];
    const leak = findReadable(payloads, secrets);
    expect(
      leak && {
        secret: leak.secret === device.token ? "<device token>" : leak.secret,
        form: leak.form,
        direction: leak.payload.direction,
      },
    ).toBeNull();
    // Nor anywhere else the relay printed — request lines, errors, anything.
    const wranglerLog = fs.readFileSync(relay.logFile, "utf8");
    for (const secret of secrets) {
      for (const form of readableForms(secret)) {
        expect(wranglerLog.includes(form)).toBe(false);
      }
    }
  });

  /**
   * ADR-206 D4: a link minted by an older (or newer) desktop names that
   * version's build. The page it loads is a real, different build — this
   * checkout's, with its version rewritten (`fakeVersionBuild`) — and on the
   * hello it learns the desktop's version and moves itself there, keeping
   * the pairing (same origin, same `localStorage`).
   */
  test("a link naming another published version lands on the desktop's version", async ({
    app,
    window,
    tempHome,
    relay,
  }) => {
    test.setTimeout(180_000);
    const version = appVersion();
    await expectDesktopVersion(app);

    await importSeededProject(app, window, tempHome);
    await enableRemoteControl(window);
    await startRelay(window);
    const device = await pairDeviceViaRelay(window, { label: "old link" });
    await closeSettings(window);

    const oldLink = device.link.replace(
      `/app/${version}/`,
      `/app/${OTHER_VERSION}/`,
    );
    expect(oldLink).not.toBe(device.link);

    const client = await openRelayWebApp(oldLink);
    try {
      await expect
        .poll(() => new URL(client.page.url()).pathname, { timeout: 45_000 })
        .toBe(`/app/${version}/`);
      await expect(projectHeader(client.page)).toBeVisible({ timeout: 45_000 });
      // Landed on, not bounced through: the page that is up is this version's.
      expect(
        await client.page.evaluate(() =>
          [...document.scripts].map((s) => s.src).join(" "),
        ),
      ).toContain(`/app/${version}/assets/`);
      // And the other version's build really was what loaded first.
      expect(fs.readFileSync(relay.logFile, "utf8")).toContain(
        `/app/${OTHER_VERSION}/`,
      );
    } finally {
      await client.close();
    }
  });
});
