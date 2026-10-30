import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/** Catppuccin Latte's tokens, as the theme store would set them, for a light screenshot. */
async function useLightTokens(window: Page): Promise<void> {
  await window.evaluate(() => {
    const root = document.documentElement;
    const tokens: Record<string, string> = {
      "--bg": "#eff1f5",
      "--fg": "#4c4f69",
      "--dim": "#e6e9ef",
      "--surface": "#ccd0da",
      "--hover": "#dce0e8",
      "--border": "#bcc0cc",
      "--control-border": "#4c4f6940",
      "--text-primary": "#4c4f69cc",
      "--text-selected": "#4c4f69",
      "--text-dim": "#4c4f6977",
      "--accent": "#1e66f5",
    };
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  });
}

/**
 * A page's alert/confirm/prompt show as an overlay over its own pane, not a
 * native box modal to the whole window. The page still gets the user's
 * answer synchronously, and the rest of Manor stays usable meanwhile.
 */
test("a page's alert, confirm and prompt are answered in the pane", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    // A strict CSP: the dialogs must still reach Manor.
    res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'");
    res.end(`<h1 style="font-family:sans-serif">Dialogs</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const guest = (script: string) =>
    app.evaluate(
      async ({ webContents }, [prefix, js]) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
        if (!wc || wc.isLoading()) return null;
        return (await wc.executeJavaScript(js)) as unknown;
      },
      [base, script] as const,
    );
  // Open a dialog without waiting on it: the page is blocked until it's answered.
  const open = (call: string) =>
    guest(`setTimeout(() => { window.__answer = ${call}; window.__done = true; }); true`);
  const answer = () =>
    guest(`window.__done ? { answer: window.__answer } : null`);

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-page-dialogs");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");
    await expect.poll(() => guest("true"), { timeout: 10_000 }).toBe(true);

    const dialog = window.locator('[data-testid="page-dialog"]');
    const urlInput = window.locator("[data-pane-url-input]:visible");

    // confirm → OK is true.
    await open(`confirm("Delete this workspace? This can't be undone.")`);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText(`127.0.0.1:${port} says`);
    await expect(dialog).toContainText("Delete this workspace?");
    await window.screenshot({ path: "tests/e2e/artifacts/browser-dialog-confirm-dark.png" });
    // The rest of Manor stays usable while the page waits.
    await urlInput.click();
    await expect(urlInput).toBeFocused();
    await useLightTokens(window);
    await window.screenshot({ path: "tests/e2e/artifacts/browser-dialog-confirm-light.png" });
    await dialog.locator('[data-testid="page-dialog-ok"]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(answer).toEqual({ answer: true });

    // confirm → Escape is false.
    await guest(`window.__done = false; true`);
    await open(`confirm("Again?")`);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('[data-testid="page-dialog-ok"]')).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(answer).toEqual({ answer: false });

    // prompt → the typed text, accepted with Enter.
    await guest(`window.__done = false; true`);
    await open(`prompt("Your name?", "Ada")`);
    const input = dialog.locator('[data-testid="page-dialog-input"]');
    await expect(input).toHaveValue("Ada", { timeout: 10_000 });
    await expect(input).toBeFocused();
    await window.keyboard.type("Grace");
    await window.keyboard.press("Enter");
    await expect.poll(answer).toEqual({ answer: "Grace" });

    // prompt → Cancel is null.
    await guest(`window.__done = false; true`);
    await open(`prompt("Your name?")`);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('[data-testid="page-dialog-cancel"]').click();
    await expect.poll(answer).toEqual({ answer: null });

    // alert → returns once dismissed. (The page can't be asked anything
    // while it waits: it is blocked, as under a real dialog.)
    await guest(`window.__done = false; true`);
    await open(`alert("Saved")`);
    await expect(dialog).toContainText("Saved", { timeout: 10_000 });
    await window.keyboard.press("Enter");
    await expect.poll(answer).toEqual({});
  } finally {
    server.close();
  }
});

/**
 * A dialog request counts only from the pane's own page: one carrying a
 * token from a document the pane has since left, or sent from another
 * origin, opens nothing.
 */
test("a dialog request with a stale token or from another origin is refused", async ({
  app,
  window,
  tempHome,
}) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1 style="font-family:sans-serif">Dialogs</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // Two origins on the one server.
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;

  const guest = (prefix: string, script: string) =>
    app.evaluate(
      async ({ webContents }, [at, js]) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getType() === "webview" && w.getURL().startsWith(at));
        if (!wc || wc.isLoading()) return null;
        return (await wc.executeJavaScript(js)) as unknown;
      },
      [prefix, script] as const,
    );
  // The token in the newest shim of the page at `prefix`, read out of the
  // shim's source through the debugger Manor already has attached.
  const shimToken = (prefix: string) =>
    app.evaluate(async ({ webContents }, at) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(at));
      if (!wc || wc.isLoading() || !wc.debugger.isAttached()) return null;
      const scriptIds: string[] = [];
      const onMessage = (_event: unknown, method: string, params: { url?: string; scriptId?: string }) => {
        if (method === "Debugger.scriptParsed" && params.url === "manor-page-dialogs.js" && params.scriptId) {
          scriptIds.push(params.scriptId);
        }
      };
      wc.debugger.on("message", onMessage);
      try {
        await wc.debugger.sendCommand("Debugger.enable");
        const last = scriptIds.at(-1);
        if (!last) return null;
        const { scriptSource } = (await wc.debugger.sendCommand("Debugger.getScriptSource", {
          scriptId: last,
        })) as { scriptSource: string };
        return /\}\)\("([^"]+)"\);/.exec(scriptSource)?.[1] ?? null;
      } finally {
        wc.debugger.off("message", onMessage);
        await wc.debugger.sendCommand("Debugger.disable");
      }
    }, prefix);
  // Ask for a confirm straight from the page, as a stolen token would be used.
  // A refusal is a failed fetch or an empty error response: either way the
  // page learns nothing and no dialog opens.
  const request = (prefix: string, token: string) =>
    guest(
      prefix,
      `fetch("manor-dialog://${token}/", {
        method: "POST",
        body: JSON.stringify({ type: "confirm", message: "Re-enter your password", defaultText: "" }),
      }).then((r) => (r.ok ? r.json() : "refused"), () => "refused")`,
    );

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-page-dialog-guard");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/first`);
    await window.keyboard.press("Enter");
    await expect.poll(() => guest(base, "true"), { timeout: 10_000 }).toBe(true);
    const dialog = window.locator('[data-testid="page-dialog"]');

    await expect.poll(() => shimToken(`${base}/first`), { timeout: 10_000 }).toEqual(expect.any(String));
    const first = await shimToken(`${base}/first`);

    // The pane moves on to another document: it has a new token, and the
    // first one opens nothing, even from the pane's own origin.
    await guest(base, `location.href = "${base}/second"; true`);
    await expect.poll(() => guest(`${base}/second`, "true"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => shimToken(`${base}/second`), { timeout: 10_000 }).toEqual(expect.any(String));
    const second = await shimToken(`${base}/second`);
    expect(second).not.toBe(first);
    expect(await request(base, first!)).toBe("refused");
    await expect(dialog).toHaveCount(0);

    // The current token from the pane's own page does open one, so the
    // refusals above are the guard's.
    const answered = request(base, second!);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText(`127.0.0.1:${port} says`);
    await dialog.locator('[data-testid="page-dialog-ok"]').click();
    expect(await answered).toEqual({ ok: true });

    // Another origin, in another tab, with the pane's current token: refused.
    // The closed dialog handed focus back to the page; take it to the app.
    await window.locator("[data-pane-url-input]:visible").click();
    await window.keyboard.press("Escape");
    await window.keyboard.press("ControlOrMeta+Shift+b");
    await expect(window.locator("webview:visible")).toHaveCount(1, { timeout: 10_000 });
    await expect(window.locator("[data-pane-url-input]:visible")).toHaveValue("");
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${other}/`);
    await window.keyboard.press("Enter");
    await expect.poll(() => guest(other, "true"), { timeout: 10_000 }).toBe(true);
    expect(await request(other, second!)).toBe("refused");
    await expect(dialog).toHaveCount(0);
  } finally {
    server.close();
  }
});
