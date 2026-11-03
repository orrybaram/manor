import fs from "fs";
import path from "path";

import { expect, type Locator, type Page } from "@playwright/test";

import { createWorkspace, importSeededProject, killApp, launchApp, openTerminalTab } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, openSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { useTheme } from "./helpers/theme";
import { waitForAppDocument } from "./helpers/window";

/**
 * Settings › Font's Chat row: five bundled fonts redraw an open desk chat in
 * place, the size steps it, code and tool lines stay out of it, a phone follows
 * the family but not the size, and all three rows pick alike. Screenshots go to
 * artifacts/chat-font.
 */

const BUNDLED = ["Inter", "Literata", "Atkinson Hyperlegible Next", "IBM Plex Sans", "JetBrains Mono"];
const TITLE = "e2e-chat-font";

const style = (el: Locator, prop: "fontFamily" | "fontSize") =>
  el.evaluate((node, p) => getComputedStyle(node)[p], prop);

/** The bundled chat faces the page has started to fetch, as "family/style". */
const fetchedFaces = (page: Page) =>
  page.evaluate(
    (bundled) =>
      [...document.fonts]
        .map((f) => ({ family: f.family.replace(/"/g, "").replace("Manor Chat ", ""), status: f.status }))
        .filter((f) => bundled.includes(f.family) && f.status !== "unloaded")
        .map((f) => `${f.family}/${f.status}`),
    BUNDLED,
  );

function reply(uuid: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "## Why it stopped\n\nThe relay refused the *old* token, so the phone **relinks once** and `relay-client.ts` never loops.\n\nIl1 O0 rn m — every font draws this.",
        },
      ],
    },
  });
}

async function pick(window: Page, row: string, family: string): Promise<void> {
  await window.getByTestId(`${row}-family`).click();
  await window.getByPlaceholder("Search fonts...").fill(family);
  await window.locator("#searchable-select-listbox").getByRole("option", { name: family, exact: true }).click();
  await expect(window.getByTestId(`${row}-family`)).toContainText(family);
}

async function openFonts(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByTestId("settings-nav-appearance").click();
  await window.getByTestId("chat-font").scrollIntoViewIfNeeded();
}

test.describe("chat font", () => {
  test.setTimeout(300_000);

  test("the Chat row redraws desk and phone chat, leaves code alone, and all three rows pick alike", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("chat-font");
    const dir = path.join(tempHome, "fake-chat");
    const transcript = path.join(dir, "transcript.jsonl");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "chat-font");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${transcript}" "${path.join(dir, "input.log")}" ${TITLE}`);
    await waitForVisibleSession(request, tempHome, { name: TITLE });
    fs.appendFileSync(transcript, reply("a-e2e-font") + "\n");
    await useTheme(window, "Catppuccin Mocha");

    const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
    await pane.getByTestId("pane-chat-toggle").click();
    const chat = pane.getByTestId("chat-pane");
    await expect(chat).toBeVisible();
    const assistant = chat.getByTestId("chat-assistant").filter({ hasText: "relinks once" });
    await expect(assistant).toBeVisible({ timeout: 20_000 });
    const user = chat.getByTestId("chat-user").first();
    const composer = chat.getByTestId("chat-composer-input");
    const code = assistant.locator("code").first();
    const paragraph = assistant.locator("p").first();

    // ── A fresh profile: as it always was, and nothing downloaded ──
    const systemFamily = await style(paragraph, "fontFamily");
    // The composer keeps the textarea's own font.
    expect(await style(composer, "fontFamily")).toBe(
      await window.evaluate(() => {
        const plain = document.body.appendChild(document.createElement("textarea"));
        const family = getComputedStyle(plain).fontFamily;
        plain.remove();
        return family;
      }),
    );
    const uiFamily = await chat.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(systemFamily).toBe(uiFamily);
    expect(await style(paragraph, "fontSize")).toBe("14px");
    expect(await style(user, "fontSize")).toBe("14px");
    expect(await style(composer, "fontSize")).toBe("16px");
    expect(await style(code, "fontSize")).toBe("13px");
    const codeFamily = await style(code, "fontFamily");
    expect(await fetchedFaces(window)).toEqual([]);
    await film.shot(window, "dark-chat-system");

    // ── All three rows pick alike ──
    await openFonts(window);
    expect(await fetchedFaces(window)).toEqual([]);
    await film.shot(window, "dark-settings-three-rows");
    for (const row of ["terminal-font", "editor-font", "chat-font"]) {
      await window.getByTestId(`${row}-family`).click();
      const list = window.locator("#searchable-select-listbox");
      await expect(list.getByText("Manor", { exact: true })).toBeVisible();
      const first = list.getByRole("option").first();
      await expect(first).toBeVisible();
      // The list rests on the current choice, so Enter changes nothing.
      await window.keyboard.press("Enter");
      await expect(list).toBeHidden();
      await window.getByTestId(`${row}-family`).click();
      await expect(list).toBeVisible();
      if (row === "chat-font") {
        for (const family of BUNDLED) {
          const option = list.getByRole("option", { name: family, exact: true });
          await expect(option).toBeVisible();
          expect(await style(option.locator("span").first(), "fontFamily")).toContain(family);
        }
        // The sample follows the highlight, and puts itself back on leaving.
        const sample = window.getByTestId("chat-font-sample");
        await list.getByRole("option", { name: "Literata", exact: true }).hover();
        await expect.poll(() => style(sample, "fontFamily")).toContain("Literata");
        await film.shot(window, "dark-chat-picker-open");
        await window.keyboard.press("Escape");
        await expect.poll(() => style(sample, "fontFamily")).not.toContain("Literata");
        expect((await window.evaluate(() => window.electronAPI.preferences.getAll())).chatFontFamily).toBe("");
      } else {
        await film.shot(window, `dark-${row}-picker-open`);
        await window.keyboard.press("Escape");
      }
    }

    // ── Each bundled font draws a chat already open, its face really loaded ──
    for (const family of BUNDLED) {
      await pick(window, "chat-font", family);
      await closeSettings(window);
      await expect.poll(() => style(paragraph, "fontFamily")).toContain(family);
      expect(await style(user, "fontFamily")).toContain(family);
      expect(await style(composer, "fontFamily")).toContain(family);
      await expect.poll(() => fetchedFaces(window)).toContain(`${family}/loaded`);
      // Out of its reach.
      expect(await style(code, "fontFamily")).toBe(codeFamily);
      await film.shot(window, `dark-chat-${family.toLowerCase().replace(/ /g, "-")}`);
      await openFonts(window);
    }

    // ── The size steps messages and composer, keeping their steps apart ──
    await pick(window, "chat-font", "Literata");
    const larger = window.getByRole("button", { name: "Larger chat font" });
    for (let i = 0; i < 4; i++) await larger.click();
    await expect(window.getByTestId("chat-font-size")).toContainText("18 px");
    await film.shot(window, "dark-settings-chat-literata-18");
    await useTheme(window, "Catppuccin Latte");
    await film.shot(window, "light-settings-chat-literata-18");
    await window.getByTestId("chat-font-family").click();
    await film.shot(window, "light-chat-picker-open");
    await window.keyboard.press("Escape");
    await closeSettings(window);
    await expect.poll(() => style(paragraph, "fontSize")).toBe("18px");
    expect(await style(user, "fontSize")).toBe("18px");
    expect(await style(composer, "fontSize")).toBe("20px");
    expect(await style(code, "fontSize")).toBe("17px");
    await film.shot(window, "light-chat-literata-18");
    await useTheme(window, "Catppuccin Mocha");

    // ── Saved to disk with the other preferences ──
    const saved = () => {
      const files = fs
        .readdirSync(tempHome, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith("preferences.json"));
      return files.map((f) => JSON.parse(fs.readFileSync(path.join(tempHome, f), "utf8")));
    };
    await expect
      .poll(() => saved().some((p) => p.chatFontFamily === "Literata" && p.chatFontSize === 18), { timeout: 10_000 })
      .toBe(true);

    // ── A phone follows the family at its own size ──
    await openFonts(window);
    const device = await pairBrowser(window, { label: "font phone" });
    await closeSettings(window);
    const client = await openWebApp(device.link, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });
    try {
      const page = client.page;
      await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => activePaneId(page), { timeout: 15_000 }).toBe(paneId);
      const phoneChat = page.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`).getByTestId("chat-pane");
      const phoneReply = phoneChat.getByTestId("chat-assistant").filter({ hasText: "relinks once" });
      await expect(phoneReply).toBeVisible({ timeout: 20_000 });
      const phoneParagraph = phoneReply.locator("p").first();
      await expect.poll(() => style(phoneParagraph, "fontFamily")).toContain("Literata");
      expect(await style(phoneParagraph, "fontSize")).toBe("15px");
      expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-size"))).toBe("");
      await expect.poll(() => fetchedFaces(page)).toContain("Literata/loaded");

      // Picked on the desk with the phone open: the phone redraws without a reload.
      await window.evaluate(() => window.electronAPI.preferences.set("chatFontFamily", "Inter"));
      await expect.poll(() => style(phoneParagraph, "fontFamily")).toContain("Inter");
      await window.evaluate(() => window.electronAPI.preferences.set("chatFontFamily", "Literata"));
      await expect.poll(() => style(phoneParagraph, "fontFamily")).toContain("Literata");
      await film.shot(page, "phone-literata");

      // A family only the computer has: named first, so the phone falls through it.
      await window.evaluate(() => window.electronAPI.preferences.set("chatFontFamily", "Only On This Computer"));
      await expect.poll(() => style(phoneParagraph, "fontFamily")).toContain("Only On This Computer");
      expect(await style(phoneParagraph, "fontFamily")).toContain("sans-serif");
      await film.shot(page, "phone-installed-only-fallback");

      // Back to System: the chat's own font again.
      await window.evaluate(() => window.electronAPI.preferences.set("chatFontFamily", ""));
      await expect.poll(() => style(phoneParagraph, "fontFamily")).not.toContain("Only On This Computer");
    } finally {
      await client.close();
    }
  });

  /** Launches its own app, as the fixture owns the shutdown of the one it made. */
  test("the choice survives a restart", async ({ tempHome }) => {
    const first = await launchApp(tempHome);
    try {
      const window = await first.firstWindow();
      await waitForAppDocument(window);
      await openFonts(window);
      await pick(window, "chat-font", "IBM Plex Sans");
      await window.getByRole("button", { name: "Larger chat font" }).click();
      await expect(window.getByTestId("chat-font-size")).toContainText("15 px");
      await window.waitForTimeout(1_000); // past the preferences' debounced save
    } finally {
      await killApp(first);
    }

    const relaunched = await launchApp(tempHome);
    try {
      const window = await relaunched.firstWindow();
      await waitForAppDocument(window);
      await expect
        .poll(() =>
          window.evaluate(() => [
            document.documentElement.style.getPropertyValue("--chat-font-family"),
            document.documentElement.style.getPropertyValue("--chat-font-size"),
          ]),
        )
        .toEqual([expect.stringContaining("IBM Plex Sans"), "15px"]);
    } finally {
      await killApp(relaunched);
    }
  });
});
