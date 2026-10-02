import {
  chromium,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

/**
 * A browser page loaded the way any paired device loads one: it knows nothing
 * but a URL — the pairing dialog's link, with a fragment holding the token —
 * and a Chromium viewport.
 *
 * The ADR-178 web app (`openWebApp`) renders the *same* `App` the desktop
 * shows — same test ids, same sidebar, same terminal pane — so a test can
 * drive it with the desktop's own helpers.
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
 * The ADR-178 web app — the desktop renderer served to a browser by the
 * relay — at a PC viewport, opened on `pairDevice`'s link. The spec has to
 * run against a local relay (`./relay-fixture.ts`) for the link to load.
 */
export async function openWebApp(
  link: string,
  {
    headed = false,
    viewport = { width: 1280, height: 800 },
    context,
  }: OpenWebAppOptions = {},
): Promise<Client> {
  return openClient(link, {
    viewport,
    headed,
    context,
  });
}
