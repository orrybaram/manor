import { expect, type Page } from "@playwright/test";

import { startLatencyProxy } from "./helpers/latency-proxy";
import { openWebApp } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";

/**
 * ADR-230 D5 end to end: a phone whose connection drops is not "unreachable"
 * until the drop has outlasted a grace period (`DROP_GRACE_MS`, 4 s). A blip
 * the redial heals never shows the overlay; a real outage shows it and fails
 * pending calls fast instead of hanging; and it goes away on its own when the
 * network is back.
 *
 * The phone reaches the relay through a TCP proxy (`helpers/latency-proxy.ts`)
 * because that is the only thing that can cut a WebSocket: Chromium's offline
 * emulation leaves open sockets alone.
 */

const PHONE = { width: 390, height: 844 };

/**
 * A bridge call from the page, timed. It settles as `ok`, `failed` (it
 * rejected) or `hung` (it was still pending after `limitMs`).
 */
async function timedCall(
  page: Page,
  limitMs: number,
): Promise<{ outcome: "ok" | "failed" | "hung"; ms: number }> {
  return page.evaluate(async (limit) => {
    const t0 = Date.now();
    return new Promise<{ outcome: "ok" | "failed" | "hung"; ms: number }>(
      (resolve) => {
        const done = (outcome: "ok" | "failed" | "hung") =>
          resolve({ outcome, ms: Date.now() - t0 });
        const timer = setTimeout(() => done("hung"), limit);
        window.electronAPI.projects.getAll().then(
          () => {
            clearTimeout(timer);
            done("ok");
          },
          () => {
            clearTimeout(timer);
            done("failed");
          },
        );
      },
    );
  }, limitMs);
}

test("a phone's dropped connection shows unreachable only after the grace, fails calls fast, and recovers", async ({
  window,
  relay,
}) => {
  const device = await pairBrowser(window, { label: "grace phone" });
  await closeSettings(window);

  const proxy = await startLatencyProxy(relay.url, 0);
  const phoneLink = new URL(device.link);
  phoneLink.host = new URL(proxy.url).host;
  const phone = await openWebApp(phoneLink.toString(), { viewport: PHONE });
  const { page } = phone;
  const overlay = page.getByTestId("web-app-unreachable");
  try {
    await expect(page.getByTestId("phone-top-bar")).toBeVisible({
      timeout: 90_000,
    });
    expect((await timedCall(page, 10_000)).outcome).toBe("ok");

    // ── A blip: the sockets die (the browser sees 1006) and the redial
    // heals it well inside the grace.
    proxy.dropAll();
    const blipEnd = Date.now() + 3_000;
    while (Date.now() < blipEnd) {
      expect(await overlay.isVisible()).toBe(false);
      await page.waitForTimeout(100);
    }
    await expect.poll(async () => (await timedCall(page, 10_000)).outcome, {
      timeout: 20_000,
    }).toBe("ok");
    expect(await overlay.isVisible()).toBe(false);

    // ── A real drop: nothing answers, so the grace runs out.
    proxy.outage();
    const outageAt = Date.now();
    // The grace is 4 s. Asserted at 2 s, not 3 s: the first refused redial
    // and the grace timer race, and the margin keeps this honest.
    await page.waitForTimeout(2_000);
    expect(await overlay.isVisible()).toBe(false);
    await expect(overlay).toBeVisible({ timeout: 8_000 - (Date.now() - outageAt) });
    const shownAfterMs = Date.now() - outageAt;
    console.log(`unreachable overlay shown ${shownAfterMs} ms after outage`);

    // A call now settles instead of hanging. It is queued for the redial and
    // fails with it, so how long it waits is however far off the next dial is
    // on the backoff (1 s, 2 s, 4 s, 8 s...): about 2 s here, never more than
    // the 8 s step. (The ticket's 2 s bound is the typical case, not a
    // guarantee.) It may reject or, for a merged read like this one, resolve
    // with the router's last-known answer (ADR-228 D6): either is "settled".
    const during = await timedCall(page, 12_000);
    console.log(`call during outage: ${during.outcome} in ${during.ms} ms`);
    expect(during.outcome).not.toBe("hung");
    expect(during.ms).toBeLessThan(9_000);

    // ── Back: the overlay goes on its own and calls work again.
    proxy.restore();
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    await expect.poll(async () => (await timedCall(page, 10_000)).outcome, {
      timeout: 20_000,
    }).toBe("ok");
  } finally {
    await phone.close();
    await proxy.close();
  }
});
