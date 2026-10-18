import type { Page } from "@playwright/test";

import { expect, importSeededProject } from "./fixtures";
import { openWebApp } from "./helpers/phone";
import { findReadable } from "./helpers/relay";
import { withLocalRelay } from "./helpers/relay-fixture";
import {
  deviceToken,
  pairBrowser,
  revokeDevice,
  roomOf,
} from "./helpers/settings";

/**
 * ADR-240 end to end: a pairing link carries a single-use, short-lived
 * pairing ticket, never the device's long-lived token.
 *
 * 1. The link works once. The browser that opens it first chooses its own
 *    token and redeems the ticket with it; a second browser on the same link
 *    is refused, while the first keeps working across a reload. Neither the
 *    ticket nor the token is readable in anything the relay forwarded, and
 *    the token is in no URL.
 * 2. A link nobody opened in time reads "Link expired" on its row and is
 *    refused; New link hands over a different link that works. The app runs
 *    with a short TTL (`MANOR_PAIRING_TICKET_TTL_MS`, read when the device
 *    store is built in the main process).
 * 3. A device still waiting for its link can be removed, and its link dies
 *    with it.
 *
 * Runs against a local relay (`helpers/relay-fixture.ts`): needs Node >= 22
 * on PATH and `pnpm build && pnpm build:web:relay` first.
 */

const test = withLocalRelay();

/**
 * Long enough to cover a fresh Chromium loading the web app and saying hello
 * after New link, short enough to wait out once.
 */
const SHORT_TTL_MS = 15_000;

const shortTtlTest = test.extend({
  appLaunch: async ({ relay }, use) => {
    await use({
      env: {
        MANOR_RELAY_URL: relay.url,
        MANOR_PAIRING_TICKET_TTL_MS: String(SHORT_TTL_MS),
      },
      asPackage: true,
    });
  },
});

/** The seeded project `importSeededProject` opens. */
const PROJECT_NAME = "test-project";

/** The web app is up: the desktop's sidebar, with the seeded project. */
function projectHeader(page: Page) {
  return page.getByTestId("project-header").filter({ hasText: PROJECT_NAME });
}

/** A device's row on Settings → Devices. */
function deviceRow(window: Page, label: string) {
  return window.getByTestId("remote-device-row").filter({ hasText: label });
}

/** Every URL the page loaded, as the browser recorded it. */
function loadedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    location.href,
    ...performance.getEntries().map((e) => e.name),
  ]);
}

test.describe("single-use pairing links", () => {
  test("a link works once, a second browser on it is refused, and the token is never in a URL or the relay's traffic", async ({
    app,
    window,
    tempHome,
    relay,
  }) => {
    test.setTimeout(180_000);
    await importSeededProject(app, window, tempHome);

    // `pairBrowser` throws on a link carrying `t=`, so a ticket it is.
    const device = await pairBrowser(window, { label: "once browser" });
    expect(new URL(device.link).hash).toContain(`&ticket=${device.ticket}`);
    expect(device.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = deviceRow(window, device.label);
    await expect(row).toContainText("Waiting for the device to open the link");
    await expect(row.getByTestId("remote-device-new-link")).toBeVisible();

    const first = await openWebApp(device.link);
    try {
      await expect(projectHeader(first.page)).toBeVisible({ timeout: 45_000 });
      // The fragment is gone from the address bar once read.
      expect(new URL(first.page.url()).hash).toBe("");

      // The browser chose its token; the link never held it.
      const token = await deviceToken(first.page, device.link);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toBe(device.ticket);
      expect(device.link).not.toContain(token);
      for (const url of await loadedUrls(first.page)) {
        expect(url).not.toContain(token);
      }

      // Redeemed: the row is an ordinary paired device now.
      await expect(row).toContainText("last seen", { timeout: 15_000 });
      await expect(row.getByTestId("remote-device-new-link")).toHaveCount(0);

      // A second browser, nothing shared with the first, on the same link:
      // the ticket is spent, so it is not paired.
      const second = await openWebApp(device.link);
      try {
        await expect(second.page.getByTestId("web-app-no-token")).toBeVisible({
          timeout: 30_000,
        });
        await expect(projectHeader(second.page)).toHaveCount(0);
      } finally {
        await second.close();
      }

      // The first browser is unaffected: a reload reconnects on its token,
      // with no ticket left to send.
      await first.page.reload();
      await expect(projectHeader(first.page)).toBeVisible({ timeout: 45_000 });
      expect(await deviceToken(first.page, device.link)).toBe(token);
      expect(
        await first.page.evaluate(
          (roomId) =>
            (
              JSON.parse(localStorage.getItem("manor.web.pairings") ?? "[]") as {
                roomId: string;
                ticket?: string;
              }[]
            ).find((p) => p.roomId === roomId)?.ticket ?? null,
          roomOf(device.link),
        ),
      ).toBeNull();
      expect(new URL(first.page.url()).hash).toBe("");

      // Blindness: neither secret is readable in anything the relay forwarded
      // — both hellos, the refusal, and the reload's.
      const leak = findReadable(relay.payloads(), [device.ticket, token]);
      expect(
        leak && {
          secret: leak.secret === token ? "<device token>" : "<pairing ticket>",
          form: leak.form,
          direction: leak.payload.direction,
        },
      ).toBeNull();
    } finally {
      await first.close();
    }
  });

  test("a device still waiting for its link can be removed, and the link dies with it", async ({
    window,
  }) => {
    test.setTimeout(120_000);
    const device = await pairBrowser(window, { label: "never opened" });
    await expect(deviceRow(window, device.label)).toContainText(
      "Waiting for the device to open the link",
    );

    await revokeDevice(window, device.label);

    const client = await openWebApp(device.link);
    try {
      await expect(client.page.getByTestId("web-app-no-token")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await client.close();
    }
  });
});

shortTtlTest.describe("an expired pairing link", () => {
  shortTtlTest(
    "is refused, and New link hands over one that works",
    async ({ app, window, tempHome }) => {
      shortTtlTest.setTimeout(180_000);
      await importSeededProject(app, window, tempHome);

      const device = await pairBrowser(window, { label: "late browser" });
      const row = deviceRow(window, device.label);
      // No timer on the server: the row turns over at `expiresAt`.
      await expect(row).toContainText("Link expired", {
        timeout: SHORT_TTL_MS + 15_000,
      });

      const late = await openWebApp(device.link);
      try {
        await expect(late.page.getByTestId("web-app-no-token")).toBeVisible({
          timeout: 30_000,
        });
      } finally {
        await late.close();
      }
      // The refusal leaves the row as it was: still there, still expired.
      await expect(row).toContainText("Link expired");

      await row.getByTestId("remote-device-new-link").click();
      const dialog = window.getByTestId("remote-pairing-dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText("This link works once");
      const link =
        (await window
          .getByTestId("remote-pairing-link")
          .getAttribute("data-link")) ?? "";
      const params = new URLSearchParams(new URL(link).hash.slice(1));
      expect(params.has("t")).toBe(false);
      expect(params.get("ticket")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(params.get("ticket")).not.toBe(device.ticket);
      expect(link).not.toBe(device.link);
      expect(roomOf(link)).toBe(roomOf(device.link));
      await window.getByTestId("remote-pairing-done").click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
      await expect(row).toContainText("Waiting for the device to open the link");

      const client = await openWebApp(link);
      try {
        await expect(projectHeader(client.page)).toBeVisible({
          timeout: 45_000,
        });
        await expect(row).toContainText("last seen", { timeout: 15_000 });
        await expect(row.getByTestId("remote-device-new-link")).toHaveCount(0);
      } finally {
        await client.close();
      }
    },
  );
});
