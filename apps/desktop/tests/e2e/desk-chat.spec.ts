import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_BANNER, FAKE_AGENT_TRANSCRIPT, FAKE_CHAT_PROMPT, FAKE_CHAT_REPLY } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { closeSettings, openSettings } from "./helpers/settings";
import { useTheme } from "./helpers/theme";
import { activePaneId, awaitShellReady, paneText, runInTerminal } from "./helpers/terminal";

/**
 * The phone's chat, on the desk (#559): a Claude pane opens on its terminal,
 * and its header button, its right-click menu, ⌘⇧M and the palette's Toggle
 * Chat View each flip it to the chat and back. The terminal under the chat is
 * never remounted, the desk remembers the pane's choice across a reload
 * without touching the phone's, and Settings › General › Agent Chat opens new
 * agent panes on the chat.
 *
 * The session is the transcript agent (`helpers/fake-agent-transcript.sh`),
 * which writes the transcript and logs what was typed into its PTY, so a
 * sent message is checked against what the agent read.
 */

const ENTER = "\r";

function paneLocator(page: Page, paneId: string) {
  return page.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
}

function inputLog(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").replace(/\n/g, ENTER) : "";
}

test.describe("desk chat view", () => {
  test.setTimeout(240_000);

  test("a desk pane flips between its terminal and its chat four ways, keeps its choice, and the setting opens new panes on the chat", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("desk-chat");
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");
    const inputLogFile = path.join(chatDir, "input.log");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "desk-chat");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${inputLogFile}" e2e-desk-chat`);
    await waitForVisibleSession(request, tempHome, { name: "e2e-desk-chat" });

    const pane = paneLocator(window, paneId);
    const toggle = pane.getByTestId("pane-chat-toggle");
    const terminal = pane.locator('[data-testid="terminal-pane"]');
    const chat = pane.getByTestId("chat-pane");

    // 1. Opens on the terminal, as today; the chat is one click away and not mounted.
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await expect(toggle).toHaveAttribute("aria-label", "Show as Chat");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(chat).toHaveCount(0);
    await expect(terminal).toBeVisible();
    await expect.poll(() => paneText(window, paneId), { timeout: 15_000 }).toContain(FAKE_AGENT_BANNER);
    await useTheme(window, "Catppuccin Mocha");
    await film.shot(window, "dark-terminal");

    // 2. Header button → the chat, in its column, the transcript rendered.
    await toggle.click();
    await expect(chat).toBeVisible({ timeout: 20_000 });
    await expect(chat).toHaveAttribute("data-layout", "desk");
    await expect(terminal).not.toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT })).toBeVisible({ timeout: 20_000 });
    await expect(chat.getByTestId("chat-assistant").filter({ hasText: FAKE_CHAT_REPLY })).toBeVisible();
    const column = await chat.getByTestId("chat-composer").boundingBox();
    expect(column?.width ?? 0).toBeLessThanOrEqual(760);
    await film.shot(window, "dark-chat-wide");

    // 3. The composer types into the agent's PTY, and the reply lands in the chat.
    const message = "hello from the desk chat";
    await chat.getByTestId("chat-composer-input").fill(message);
    await chat.getByTestId("chat-send").click();
    await expect.poll(() => inputLog(inputLogFile), { timeout: 15_000 }).toContain(message + ENTER);
    await expect(chat.getByTestId("chat-user").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
    await film.shot(window, "dark-chat-sent");

    // 4. ⌘⇧M → the same terminal, its scrollback intact.
    await window.keyboard.press("ControlOrMeta+Shift+m");
    await expect(terminal).toBeVisible();
    await expect(chat).not.toBeVisible();
    expect(await paneText(window, paneId)).toContain(FAKE_AGENT_BANNER);

    // 5. The palette's Toggle Chat View → the chat.
    await window.keyboard.press("ControlOrMeta+k");
    const paletteInput = window.locator("[cmdk-input]");
    await expect(paletteInput).toBeVisible({ timeout: 10_000 });
    await paletteInput.fill("Toggle Chat View");
    await film.shot(window, "dark-palette");
    await window.locator("[cmdk-item]", { hasText: "Toggle Chat View" }).first().click();
    await expect(chat).toBeVisible();
    await expect(terminal).not.toBeVisible();

    // 6. The header's right-click menu → the terminal, then the chat again.
    const header = pane.getByTestId("pane-status-bar");
    await header.click({ button: "right", position: { x: 40, y: 8 } });
    const menuItem = window.getByTestId("pane-chat-toggle-menu");
    await expect(menuItem).toHaveText(/Show Terminal/);
    await film.shot(window, "dark-header-menu");
    await menuItem.click();
    await expect(terminal).toBeVisible();
    await header.click({ button: "right", position: { x: 40, y: 8 } });
    await expect(menuItem).toHaveText(/Show as Chat/);
    await menuItem.click();
    await expect(chat).toBeVisible();

    // 7. A reload comes back on the chat; the phone's choice was never written.
    await window.reload();
    await expect(paneLocator(window, paneId).getByTestId("chat-pane")).toBeVisible({ timeout: 30_000 });
    const stored = await window.evaluate((id) => ({
      desk: localStorage.getItem(`manor:pane-view:desk:${id}`),
      phone: localStorage.getItem(`manor:pane-view:${id}`),
    }), paneId);
    expect(stored).toEqual({ desk: "chat", phone: null });

    // 8. Light theme: chat and terminal.
    await useTheme(window, "Catppuccin Latte");
    await film.shot(window, "light-chat-wide");

    // 9. A split: the new pane is a plain shell, so it has no chat button.
    await pane.getByRole("button", { name: "Split pane" }).click();
    await expect(window.locator('[data-testid="workspace-pane"]')).toHaveCount(2, { timeout: 15_000 });
    const ids = await window
      .locator('[data-testid="workspace-pane"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-pane-id")));
    const otherId = ids.find((id) => id && id !== paneId)!;
    expect(otherId).toBeTruthy();
    const other = paneLocator(window, otherId);
    await awaitShellReady(window, tempHome, otherId);
    await expect(other.getByTestId("pane-chat-toggle")).toHaveCount(0);
    await film.shot(window, "light-chat-narrow-and-shell");

    // 10. Settings › General › Agent Chat on → a new agent pane opens on its chat.
    await openSettings(window);
    await window.getByTestId("settings-nav-general").click();
    const sw = window.getByTestId("desk-chat-by-default");
    await sw.scrollIntoViewIfNeeded();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await film.shot(window, "light-setting");
    await closeSettings(window);

    const t2 = path.join(tempHome, "fake-chat-2", "transcript.jsonl");
    const l2 = path.join(tempHome, "fake-chat-2", "input.log");
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${t2}" "${l2}" e2e-desk-chat-2`);
    await waitForVisibleSession(request, tempHome, { name: "e2e-desk-chat-2" });
    await expect(other.getByTestId("chat-pane")).toBeVisible({ timeout: 20_000 });
    await expect(other.getByTestId("pane-chat-toggle")).toHaveAttribute("aria-pressed", "true");
    await film.shot(window, "light-setting-new-pane-chat");

    // 11. The dark theme, two chats side by side, narrow.
    await useTheme(window, "Catppuccin Mocha");
    await film.shot(window, "dark-chat-narrow-split");
  });
});
