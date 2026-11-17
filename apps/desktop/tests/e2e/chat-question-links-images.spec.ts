import fs from "fs";
import path from "path";
import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * In a desk chat, a URL in Claude's question card is a link, and an image
 * pasted into a prompt shows as the image rather than its path.
 * The question is the transcript agent's, its text swapped for one with a
 * link; the image is sent through the composer, which the agent echoes back
 * as a user line.
 */

const QUESTION_URL = "https://example.com/plan";

test("a desk chat links a URL in a question card and shows a pasted image in its prompt", async ({
  app,
  window,
  tempHome,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const chatDir = path.join(tempHome, "fake-chat");
  const imageDir = path.join(tempHome, ".manor", "pasted-images");
  const imagePath = path.join(imageDir, "20261117-104148-12e4ba54.png");
  fs.mkdirSync(imageDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../../src/web/icons/icon-192.png"), imagePath);

  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "chat-question-links");
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(
    window,
    `FAKE_QUESTION_TEXT='Plan is at ${QUESTION_URL} (4 tickets). OK to build?' "${FAKE_AGENT_TRANSCRIPT}" "${path.join(chatDir, "transcript.jsonl")}" "${path.join(chatDir, "input.log")}" e2e-question-links`,
  );
  await waitForVisibleSession(request, tempHome, { name: "e2e-question-links" });

  const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
  await pane.getByTestId("pane-chat-toggle").click({ timeout: 20_000 });
  const chat = pane.getByTestId("chat-pane");
  await expect(chat).toBeVisible({ timeout: 20_000 });

  // The question's URL is a link, with the chat's link menu.
  const card = chat.getByTestId("chat-question");
  const link = card.locator(`a[href="${QUESTION_URL}"]`);
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("(4 tickets). OK to build?");
  await window.screenshot({ path: testInfo.outputPath("question-link.png") });
  await link.click({ button: "right" });
  await expect(window.locator('[role="menu"] [role="menuitem"]').first()).toHaveText(
    "Open in New Browser Tab",
  );
  await window.keyboard.press("Escape");

  // A pasted image's path, sent from the composer, comes back as the image.
  await chat.getByTestId("chat-composer-input").fill(`what is this ${imagePath}`);
  await chat.getByTestId("chat-send").click();
  const bubble = chat.getByTestId("chat-user").filter({ hasText: "what is this" });
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  await expect(bubble).not.toContainText("pasted-images");
  const img = bubble.getByTestId("chat-image").locator("img");
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(192);
  await window.screenshot({ path: testInfo.outputPath("pasted-image.png") });

  // A click shows it at the bubble's width, and another puts it back.
  const thumb = bubble.getByTestId("chat-image");
  await thumb.click();
  await expect(thumb).toHaveAttribute("aria-expanded", "true");
  await window.screenshot({ path: testInfo.outputPath("pasted-image-large.png") });
  await thumb.click();
  await expect(thumb).toHaveAttribute("aria-expanded", "false");
});
