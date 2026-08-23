import { chromium, type Locator, type Page } from "@playwright/test";

/**
 * The ADR-161 client, driven the way a paired phone drives it: an ordinary
 * browser page on a phone-shaped viewport that knows nothing but an address
 * and a bearer token, which is the whole contract the client may rely on.
 */

export interface Phone {
  page: Page;
  /** Everything the page logged, plus any failed or 4xx/5xx request. */
  log: string[];
  close(): Promise<void>;
}

export async function openPhoneClient(
  port: number,
  token: string,
  { headed = false }: { headed?: boolean } = {},
): Promise<Phone> {
  const browser = await chromium.launch({ headless: !headed });
  const origin = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // Granted rather than left to a prompt: the client asks for notification
    // permission on load, and an unanswered prompt would leave push in a state
    // no phone is ever in.
    permissions: ["notifications"],
  });
  await context.grantPermissions(["notifications"], { origin });

  const page = await context.newPage();
  const log: string[] = [];
  page.on("console", (msg) => log.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => log.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) =>
    log.push(
      `[requestfailed] ${req.method()} ${req.url()} — ${
        req.failure()?.errorText ?? "unknown"
      }`,
    ),
  );
  page.on("response", (res) => {
    if (res.status() >= 400) log.push(`[http ${res.status()}] ${res.url()}`);
  });

  await page.goto(`${origin}/#${token}`);

  return {
    page,
    log,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * One session row in the client's list.
 *
 * Addressed by what it says rather than by position: `GET /tasks` also returns
 * the prewarmed session Manor keeps warm in the background, which has no
 * project and is therefore indistinguishable from the real one by rank alone.
 */
export function sessionRow(
  page: Page,
  { name, project }: { name: string; project: string },
): Locator {
  return page
    .locator("li.session")
    .filter({ hasText: name })
    .filter({ hasText: project });
}
