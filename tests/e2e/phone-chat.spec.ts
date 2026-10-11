import fs from "fs";
import path from "path";
import { expect, type APIRequestContext, type ElectronApplication, type Page } from "@playwright/test";

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

    // The desk never offers the chat (ADR-215 D7): it has no phone top bar,
    // so no overflow menu to switch views from, and no chat in the pane.
    await expect(window.getByTestId("phone-top-bar")).toHaveCount(0);
    await expect(window.getByTestId("phone-overflow-view")).toHaveCount(0);
    await expect(window.getByTestId("chat-pane")).toHaveCount(0);

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

      // 1. The pane has a transcript, so it shows as a chat by default, and
      // the top bar's overflow menu offers the terminal instead.
      const chat = pane.getByTestId("chat-pane");
      await expect(chat).toBeVisible({ timeout: 20_000 });
      await expect(pane.locator('[data-testid="terminal-pane"]')).not.toBeVisible();

      const overflowButton = page.getByTestId("phone-overflow-button");
      const viewItem = page.getByTestId("phone-overflow-view");
      await overflowButton.tap();
      await expect(viewItem).toBeVisible({ timeout: 20_000 });
      await expect(viewItem).toHaveText("Show terminal");
      await film.shot(page, "00-overflow-menu");
      // Escape closes the menu without switching.
      await page.keyboard.press("Escape");
      await expect(viewItem).toBeHidden();
      await expect(chat).toBeVisible();

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
      await overflowButton.tap();
      await viewItem.tap();
      await expect(viewItem).toBeHidden();
      await expect(pane.locator('[data-testid="terminal-pane"]')).toBeVisible();
      await expect(chat).not.toBeVisible();
      await expect
        .poll(() => paneText(page, paneId), { timeout: 15_000 })
        .toContain(FAKE_AGENT_BANNER);
      await film.shot(page, "04-terminal");

      // 6. Back to Chat: nothing was remounted, so the history is all there.
      await overflowButton.tap();
      await expect(viewItem).toHaveText("Show chat");
      await viewItem.tap();
      await expect(viewItem).toBeHidden();
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

/** A transcript line, the way Claude Code writes a skill listing (ADR-217). */
function skillListingLine(isInitial: boolean, skills: Record<string, string>): string {
  return JSON.stringify({
    type: "attachment",
    attachment: {
      type: "skill_listing",
      isInitial,
      skillCount: Object.keys(skills).length,
      names: Object.keys(skills),
      content: Object.entries(skills)
        .map(([name, description]) => `- ${name}: ${description}`)
        .join("\n"),
    },
  });
}

let appendedLines = 0;
/** A plain user line, as a TUI-run slash command or its output is written. */
function userLine(text: string): string {
  appendedLines += 1;
  return JSON.stringify({
    type: "user",
    uuid: `u-e2e-appended-${appendedLines}`,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  });
}

function appendTranscript(file: string, ...lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => l + "\n").join(""));
}

const PLUGIN_SKILL = "acme-tools:ship";

/**
 * A desk running the transcript agent, a paired phone, and the pane's chat.
 * `seed` runs after the agent has written its transcript and before the phone
 * opens; it may append lines (the pane's parser reads them as they land).
 */
async function openChatPhone(
  fixtures: {
    app: ElectronApplication;
    window: Page;
    tempHome: string;
    request: APIRequestContext;
  },
  name: string,
  seed: (transcriptFile: string) => void,
) {
  const { app, window, tempHome, request } = fixtures;
  const chatDir = path.join(tempHome, "fake-chat");
  const transcriptFile = path.join(chatDir, "transcript.jsonl");
  const inputLogFile = path.join(chatDir, "input.log");

  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, name);
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(
    window,
    `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${inputLogFile}" ${AGENT_TITLE}`,
  );
  await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });
  expect(fs.existsSync(transcriptFile)).toBe(true);
  seed(transcriptFile);

  const device = await pairBrowser(window, { label: "chat phone" });
  await closeSettings(window);
  const client = await openWebApp(device.link, {
    viewport: { width: 390, height: 844 },
    context: { isMobile: true, hasTouch: true },
  });
  const page = client.page;
  await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => activePaneId(page), { timeout: 15_000 }).toBe(paneId);
  const pane = paneLocator(page, paneId);
  const chat = pane.getByTestId("chat-pane");
  await expect(chat).toBeVisible({ timeout: 20_000 });
  return { client, page, pane, chat, transcriptFile, inputLogFile };
}

test.describe("phone chat slash commands (ADR-217)", () => {
  test.setTimeout(240_000);

  test("the slash menu lists built-ins and skills, filters, picks, and sends a skill to the PTY", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const seededMarker = "skills seeded marker";
    const { client, chat, inputLogFile } = await openChatPhone(
      { app, window, tempHome, request },
      "phone-chat-menu",
      (transcriptFile) =>
        appendTranscript(
          transcriptFile,
          skillListingLine(true, {
            "review-pr": "Look over a pull request",
            [PLUGIN_SKILL]: "Release the build",
          }),
          skillListingLine(false, { "late-skill": "Added after a plugin loaded" }),
          // Read after the listings, so once it renders the parser has them.
          userLine(seededMarker),
        ),
    );
    try {
      await expect(chat.getByTestId("chat-user").filter({ hasText: seededMarker })).toBeVisible({
        timeout: 20_000,
      });
      const input = chat.getByTestId("chat-composer-input");
      const menu = chat.getByTestId("slash-command-menu");
      const items = menu.getByTestId("slash-command-item");

      // `/` lists built-ins (alphabetical, so the first is one of them).
      await input.fill("/");
      await expect(menu).toBeVisible({ timeout: 15_000 });
      await expect(items.first()).toBeVisible();
      await expect(menu.locator('[data-command="add-dir"]')).toBeVisible();
      await expect(chat.getByTestId("slash-command-footer")).toHaveCount(0);

      // The delta listing's skill is known too.
      await input.fill("/late");
      await expect(menu.locator('[data-command="late-skill"]')).toBeVisible();

      // A prefix of the part after the plugin's `:` ranks the plugin skill first.
      await input.fill("/");
      await input.pressSequentially("shi");
      await expect(items.first()).toHaveAttribute("data-command", PLUGIN_SKILL);

      // Tapping it fills the input with the full name and a space.
      await items.first().tap();
      await expect(input).toHaveValue(`/${PLUGIN_SKILL} `);
      await expect(menu).toHaveCount(0);

      await expect(input).toBeFocused();
      await input.pressSequentially("args");
      await chat.getByTestId("chat-send").tap();
      await expect
        .poll(() => inputLog(inputLogFile), { timeout: 15_000 })
        .toContain(`/${PLUGIN_SKILL} args${ENTER}`);
      await expect(input).toHaveValue("");
    } finally {
      await client.close();
    }
  });

  test("a slash command and its output show as a chip that expands", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const { client, chat, transcriptFile } = await openChatPhone(
      { app, window, tempHome, request },
      "phone-chat-chip",
      () => {},
    );
    try {
      appendTranscript(
        transcriptFile,
        userLine(
          "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
        ),
        userLine("<local-command-stdout>done</local-command-stdout>"),
      );
      const chip = chat.getByTestId("chat-command");
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await expect(chip).toContainText("/clear");
      await expect(chat.getByText("done", { exact: true })).toHaveCount(0);
      await chip.tap();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(chat.getByText("done", { exact: true })).toBeVisible();
    } finally {
      await client.close();
    }
  });

  test("a transcript with no skill listing shows built-ins and the footer", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const { client, chat } = await openChatPhone(
      { app, window, tempHome, request },
      "phone-chat-nolisting",
      () => {},
    );
    try {
      await chat.getByTestId("chat-composer-input").fill("/");
      const menu = chat.getByTestId("slash-command-menu");
      await expect(menu).toBeVisible({ timeout: 15_000 });
      await expect(menu.locator('[data-command="add-dir"]')).toBeVisible();
      await expect(chat.getByTestId("slash-command-footer")).toHaveText(
        "Skills appear after your first message.",
      );
    } finally {
      await client.close();
    }
  });

  test("sending an interactive command switches the pane to the terminal", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const { client, pane, chat, inputLogFile } = await openChatPhone(
      { app, window, tempHome, request },
      "phone-chat-interactive",
      () => {},
    );
    try {
      const input = chat.getByTestId("chat-composer-input");
      await input.fill("/");
      await input.pressSequentially("model");
      const row = chat.getByTestId("slash-command-menu").locator('[data-command="model"]');
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.tap();
      await expect(input).toHaveValue("/model ");
      await chat.getByTestId("chat-send").tap();
      await expect
        .poll(() => inputLog(inputLogFile), { timeout: 15_000 })
        .toContain(`/model${ENTER}`);
      await expect(pane.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 15_000 });
      await expect(chat).not.toBeVisible();
    } finally {
      await client.close();
    }
  });
});
