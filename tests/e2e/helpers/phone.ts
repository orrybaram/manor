import {
  chromium,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * A browser page loaded against Manor's own address, driven the way any
 * paired device drives it: it knows nothing but a URL — the pairing dialog's
 * link, with a fragment holding the token — and a Chromium viewport.
 *
 * Two shapes come out of this. The ADR-161 phone client (`openPhoneClient`)
 * loads `/#token` at a phone viewport and renders its own tiny UI. The
 * ADR-178 web app (`openWebApp`) loads `/app#token` at a PC viewport and
 * renders the *same* `App` the desktop shows — same test ids, same sidebar,
 * same terminal pane — so a test can drive it with the desktop's own helpers.
 */

export interface Client {
  page: Page;
  /** Everything the page logged, plus any failed or 4xx/5xx request. */
  log: string[];
  close(): Promise<void>;
}

export interface OpenClientOptions {
  viewport: { width: number; height: number };
  headed?: boolean;
  /** Passed through to `newContext`, layered under `viewport`/`permissions`. */
  context?: BrowserContextOptions;
}

/**
 * Load `url` in its own browser, context and page — nothing shared with the
 * Electron app or any other client this run opens.
 */
export async function openClient(
  url: string,
  { viewport, headed = false, context: contextOverrides = {} }: OpenClientOptions,
): Promise<Client> {
  const browser = await chromium.launch({ headless: !headed });
  const origin = new URL(url).origin;
  const context = await browser.newContext({
    viewport,
    permissions: ["notifications"],
    ...contextOverrides,
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

  await page.goto(url);

  return {
    page,
    log,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/** The ADR-161 client, at the phone viewport its layout is built for. */
export async function openPhoneClient(
  port: number,
  token: string,
  { headed = false }: { headed?: boolean } = {},
): Promise<Client> {
  return openClient(`http://127.0.0.1:${port}/#${token}`, {
    viewport: { width: 390, height: 844 },
    headed,
    context: { deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  });
}

export interface OpenWebAppOptions {
  headed?: boolean;
  /**
   * Defaults to a PC viewport. ADR-181's phone tests pass a phone size
   * instead — the same `/app` bundle, the same desktop renderer, dropped
   * into phone mode by width alone (ADR-181 D2), with nothing else about
   * how it is opened any different from a PC browser.
   */
  viewport?: { width: number; height: number };
  /** Passed through to `newContext`, layered under `viewport`. */
  context?: BrowserContextOptions;
}

/**
 * The ADR-178 web app — the desktop renderer served to a browser — at a PC
 * viewport. `pairDevice`'s token, `/app` in place of `/`, same fragment.
 */
export async function openWebApp(
  port: number,
  token: string,
  {
    headed = false,
    viewport = { width: 1280, height: 800 },
    context,
  }: OpenWebAppOptions = {},
): Promise<Client> {
  return openClient(`http://127.0.0.1:${port}/app#${token}`, {
    viewport,
    headed,
    context,
  });
}

/**
 * One session row in the phone client's list.
 *
 * Addressed by what it says rather than by position: `GET /agents` also returns
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
