import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_LOG_ENV } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

const AGENT_TITLE = "pins-agent";
const NOTE = "Show seats used, e.g. 9 of 12";

/**
 * Picking stays armed: three clicks on a page pin three numbered notes, the
 * first with a remark. Send to… hands them to an agent already in the
 * workspace as one prompt, each with a screenshot saved where the agent runs.
 *
 * The pins are drawn in the page's closed shadow root, out of the page's
 * reach and of `executeJavaScript`'s; the guest's debugger can still pierce
 * it, which is how they are counted here.
 */
test("picked elements become pins and notes, and Send hands them to an agent in one prompt", async ({
  app,
  window,
  tempHome,
  request,
}) => {
  test.setTimeout(180_000);
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<body style="margin:0;padding:24px;font:14px sans-serif;background:#f6f6f8">
         ${["Plan", "Seats", "Invoices"]
           .map(
             (name, i) =>
               `<div class="card" id="card-${i + 1}" style="margin:0 0 16px;padding:16px;width:280px;height:48px;background:#fff;border:1px solid #ddd;border-radius:8px">${name}</div>`,
           )
           .join("")}
       </body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const agentLog = path.join(tempHome, "pins-agent-input.log");

  const guest = <T,>(script: string) =>
    app.evaluate(
      async ({ webContents }, [prefix, js]) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
        if (!wc || wc.isLoading()) return null;
        return (await wc.executeJavaScript(js)) as unknown;
      },
      [base, script] as const,
    ) as Promise<T | null>;

  /** The pins' numbers, read through the debugger's view of the closed shadow root. */
  const pinLabels = () =>
    app.evaluate(async ({ webContents }, prefix) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL().startsWith(prefix));
      if (!wc) return null;
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      type Node = { nodeName: string; attributes?: string[]; children?: Node[]; shadowRoots?: Node[]; nodeValue?: string };
      const { root } = (await wc.debugger.sendCommand("DOM.getDocument", { depth: -1, pierce: true })) as { root: Node };
      const labels: string[] = [];
      const text = (n: Node): string => (n.nodeValue ?? "") + (n.children ?? []).map(text).join("");
      const walk = (n: Node, inPins: boolean) => {
        const attrs = n.attributes ?? [];
        const cls = attrs[attrs.indexOf("class") + 1];
        if (inPins && n.nodeName === "BUTTON" && attrs.includes("class") && cls.split(" ").includes("pin")) {
          labels.push(text(n));
        }
        for (const c of n.children ?? []) walk(c, inPins);
        for (const s of n.shadowRoots ?? []) walk(s, inPins || n.nodeName === "MANOR-PINS");
      };
      walk(root, false);
      return labels;
    }, base);

  try {
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-pins");
    const agentPaneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, agentPaneId);
    await runInTerminal(window, `${FAKE_AGENT_LOG_ENV}="${agentLog}" "${FAKE_AGENT}" ${AGENT_TITLE}`);
    await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });

    await window.keyboard.press("ControlOrMeta+Shift+b");
    const webview = window.locator("webview:visible");
    await expect(webview).toHaveCount(1, { timeout: 10_000 });
    await window.keyboard.press("ControlOrMeta+l");
    await window.keyboard.type(`${base}/`);
    await window.keyboard.press("Enter");
    await expect.poll(() => guest<boolean>("!!document.getElementById('card-3')"), { timeout: 10_000 }).toBe(true);

    await test.step("arm picking", async () => {
      await window.getByTestId("browser-pick-toggle").click();
      await expect(window.getByTestId("browser-picking-hint")).toHaveText(
        "Click elements to collect them · Esc to stop",
      );
      await expect.poll(() => guest<boolean>("!!window.__manor_pins__")).toBe(true);
      await window.screenshot({ path: "tests/e2e/artifacts/browser-pins-picking.png" });
    });

    const box = (await webview.boundingBox())!;
    const clickCard = async (n: number) => {
      const rect = (await guest<{ x: number; y: number }>(
        `(() => { const r = document.getElementById("card-${n}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ))!;
      await window.mouse.move(box.x + rect.x, box.y + rect.y);
      await window.mouse.click(box.x + rect.x, box.y + rect.y);
    };
    const popover = window.getByTestId("browser-note-popover");
    const input = window.getByTestId("browser-note-input");

    await test.step("pick three elements, with a note on the first", async () => {
      await clickCard(1);
      await expect(popover).toBeVisible({ timeout: 10_000 });
      await expect(popover).toContainText("div#card-1");
      await input.fill(NOTE);
      await window.screenshot({ path: "tests/e2e/artifacts/browser-pins-annotating.png" });
      await input.press("Enter");
      await expect(popover).toBeHidden();

      for (const n of [2, 3]) {
        await clickCard(n);
        await expect(popover).toContainText(`div#card-${n}`, { timeout: 10_000 });
        // Escape skips the note; picking stays armed.
        await input.press("Escape");
        await expect(popover).toBeHidden();
      }
      await expect(window.getByTestId("browser-picking-hint")).toBeVisible();
    });

    await test.step("three pins on the page, three notes on the pill", async () => {
      await expect.poll(pinLabels, { timeout: 10_000 }).toEqual(["1", "2", "3"]);
      await expect(window.getByTestId("browser-notes-pill")).toContainText("3 notes on this page");
    });

    await test.step("send them to the agent", async () => {
      await window.getByTestId("browser-notes-send").click();
      const menu = window.getByTestId("browser-notes-targets");
      await expect(menu).toContainText("New agent");
      await expect(menu).toContainText("Copy to clipboard");
      await window.screenshot({ path: "tests/e2e/artifacts/browser-pins-sending.png" });
      await menu.getByRole("button", { name: new RegExp(AGENT_TITLE) }).click();

      await expect
        .poll(() => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8") : ""), { timeout: 20_000 })
        .toContain("I left 3 notes");
      const prompts = fs
        .readFileSync(agentLog, "utf8")
        .split("\n")
        .filter((line) => line.includes("I left"));
      expect(prompts).toHaveLength(1);
      const [prompt] = prompts;
      expect(prompt).toContain(`[1] div#card-1 — ${NOTE}`);
      expect(prompt).toContain("[2] div#card-2 — (no note)");
      expect(prompt).toContain("[3] div#card-3 — (no note)");
      const shots = [...prompt.matchAll(/Screenshot: (\S+\.png)/g)].map((m) => m[1]);
      expect(shots).toHaveLength(3);
      for (const shot of shots) expect(fs.existsSync(shot)).toBe(true);
    });

    await test.step("the queue and its pins are gone", async () => {
      await expect(window.getByTestId("browser-notes-pill")).toHaveCount(0);
      await expect.poll(pinLabels, { timeout: 10_000 }).toEqual([]);
    });
  } finally {
    server.close();
  }
});
