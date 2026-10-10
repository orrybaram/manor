import fs from "fs";
import path from "path";
import { expect, type Page } from "@playwright/test";

import { createWorkspace, importSeededProject, openTerminalTab } from "./fixtures";
import {
  FAKE_AGENT_BANNER,
  FAKE_AGENT_TRANSCRIPT,
  FAKE_CHAT_OPTIONS,
  FAKE_CHAT_PROMPT,
  FAKE_CHAT_QUESTION,
  FAKE_CHAT_REPLY,
} from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * ADR-215 end to end: a phone shows a Claude pane as a chat — the pane's
 * transcript as a conversation, its AskUserQuestion as a card that answers
 * through the PTY, and a composer that sends a prompt — with the terminal one
 * toggle away and nothing remounted either way.
 *
 * Same discipline as `phone.spec.ts`: the session is the fake agent reporting
 * its own lifecycle, and the phone is an ordinary Playwright page at a
 * 390×844 touch viewport that knows nothing but its pairing link, through a
 * local relay. The transcript agent (`helpers/fake-agent-transcript.sh`)
 * writes the transcript and reads back what was typed into it, so every
 * outcome here is something the agent itself saw, not what the chat claims.
 */

/** Passed to the fake agent, which puts it in the window title → the agent name. */
const AGENT_TITLE = "e2e-chat-agent";

/** What `encodePickerAnswer` types for option 3 of a single-select question. */
const DOWN = "\x1b[B";
const ENTER = "\r";
const OPTION_3_KEYS = DOWN + DOWN + ENTER;

/** The pane's own subtree on a page, by id. */
function paneLocator(page: Page, paneId: string) {
  return page.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
}

/**
 * A pane's grid as text, read off its live `Terminal` (`window.__manorTerminals`)
 * — xterm draws into a canvas, so there is nothing in the DOM to read. Mirrors
 * `web-app.spec.ts`'s `paneText`, but empty rather than a throw while the
 * terminal has not registered yet, so it can be polled.
 */
function paneText(page: Page, paneId: string): Promise<string> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    return handle ? handle.serialize({ scrollback: 20_000 }) : "";
  }, paneId);
}

/**
 * Everything the fake agent has read from its PTY so far. The agent's tty can
 * hand it a sent CR as LF (bash's `read -n` sets its own mode), so LF reads
 * back as the CR that was written.
 */
function inputLog(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").replace(/\n/g, ENTER) : "";
}

test.describe("phone chat view (ADR-215)", () => {
  test.setTimeout(240_000);

  test("a phone reads a Claude pane as a chat, answers its picker, sends a prompt, and toggles to the terminal and back", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("phone-chat");
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");
    const inputLogFile = path.join(chatDir, "input.log");

    // ── Desk setup: the transcript agent, running in a pane ─────────────
    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "phone-chat");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(
      window,
      `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${inputLogFile}" ${AGENT_TITLE}`,
    );
    await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });
    expect(fs.existsSync(transcriptFile)).toBe(true);
    await film.shot(window, "desk-agent-running");

    // The desk never offers the chat (ADR-215 D7).
    await expect(window.getByTestId("chat-view-toggle")).toHaveCount(0);

    // ── Pair, open the phone ────────────────────────────────────────────
    const device = await pairBrowser(window, { label: "chat phone" });
    await closeSettings(window);

    const client = await openWebApp(device.link, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });

    try {
      const page = client.page;
      await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => activePaneId(page), { timeout: 15_000 }).toBe(paneId);
      const pane = paneLocator(page, paneId);

      // 1. The pane has a transcript, so it gets the toggle, with Chat chosen
      // by default.
      const toggle = pane.getByTestId("chat-view-toggle");
      await expect(toggle).toBeVisible({ timeout: 20_000 });
      const chatRadio = toggle.getByRole("radio", { name: "Chat" });
      const terminalRadio = toggle.getByRole("radio", { name: "Terminal" });
      await expect(chatRadio).toHaveAttribute("aria-checked", "true");
      await expect(terminalRadio).toHaveAttribute("aria-checked", "false");

      const chat = pane.getByTestId("chat-pane");
      await expect(chat).toBeVisible({ timeout: 20_000 });
      await expect(pane.locator('[data-testid="terminal-pane"]')).not.toBeVisible();

      // 2. The transcript renders: the prompt, the reply, and the open
      // question as a card with one button per option.
      await expect(chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT })).toBeVisible({
        timeout: 20_000,
      });
      await expect(chat.getByTestId("chat-assistant").filter({ hasText: FAKE_CHAT_REPLY })).toBeVisible();
      const card = chat.getByTestId("chat-question");
      await expect(card).toBeVisible();
      await expect(card).toContainText(FAKE_CHAT_QUESTION);
      const options = card.getByTestId("chat-question-option");
      await expect(options).toHaveCount(FAKE_CHAT_OPTIONS.length);
      await film.shot(page, "01-chat-question");

      // 3. Tap option 3. A single question with no "Other" answers on tap:
      // the agent reads Down, Down, Enter, writes its tool_result, and the
      // card collapses to the answered summary.
      await options.nth(2).tap();
      await expect.poll(() => inputLog(inputLogFile), { timeout: 15_000 }).toContain(OPTION_3_KEYS);
      const answered = chat.getByTestId("chat-question-answered");
      await expect(answered).toBeVisible({ timeout: 15_000 });
      await expect(answered).toContainText(FAKE_CHAT_OPTIONS[2]);
      await expect(chat.getByTestId("chat-question")).toHaveCount(0);
      // Exactly the one answer: no retry, no double send.
      expect(inputLog(inputLogFile).split(OPTION_3_KEYS)).toHaveLength(2);
      await film.shot(page, "02-chat-answered");

      // 4. The composer sends a prompt: the text then Enter, which the
      // agent writes back to the transcript as a user line.
      const message = "hello from the phone chat";
      await chat.getByTestId("chat-composer-input").fill(message);
      await chat.getByTestId("chat-send").tap();
      await expect.poll(() => inputLog(inputLogFile), { timeout: 15_000 }).toContain(message + ENTER);
      await expect(chat.getByTestId("chat-user").filter({ hasText: message })).toBeVisible({
        timeout: 15_000,
      });
      await expect(chat.getByTestId("chat-composer-input")).toHaveValue("");
      await film.shot(page, "03-chat-sent");

      // 5. Terminal: xterm shows, the chat hides, and the PTY it shows is
      // the same one the chat typed into.
      await terminalRadio.tap();
      await expect(terminalRadio).toHaveAttribute("aria-checked", "true");
      await expect(pane.locator('[data-testid="terminal-pane"]')).toBeVisible();
      await expect(chat).not.toBeVisible();
      await expect
        .poll(() => paneText(page, paneId), { timeout: 15_000 })
        .toContain(FAKE_AGENT_BANNER);
      await film.shot(page, "04-terminal");

      // 6. Back to Chat: nothing was remounted, so the history is all there.
      await chatRadio.tap();
      await expect(chatRadio).toHaveAttribute("aria-checked", "true");
      await expect(chat).toBeVisible();
      await expect(pane.locator('[data-testid="terminal-pane"]')).not.toBeVisible();
      await expect(chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT })).toBeVisible();
      await expect(chat.getByTestId("chat-assistant").filter({ hasText: FAKE_CHAT_REPLY })).toBeVisible();
      await expect(chat.getByTestId("chat-question-answered")).toContainText(FAKE_CHAT_OPTIONS[2]);
      await expect(chat.getByTestId("chat-user").filter({ hasText: message })).toBeVisible();
      await film.shot(page, "05-chat-again");
    } finally {
      film.write("browser-console.log", client.log.join("\n") + "\n");
      await client.close();
    }
  });
});
