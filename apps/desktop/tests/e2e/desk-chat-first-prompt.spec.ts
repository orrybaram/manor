import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { setAgentCommand } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * A new chat's first prompt, watched frame by frame: once the message is on
 * screen it stays, through the starting chat handing over to the real one.
 *
 * The session is `helpers/fake-agent-first-prompt.sh`, which keeps a real
 * Claude session's order: the transcript is named before it exists, and the
 * prompt lands in it a moment after the prompt's hook.
 */

const FIRST_PROMPT_AGENT = path.join(__dirname, "helpers", "fake-agent-first-prompt.sh");
const PROMPT = "the first message";

type Frame = { t: number; state: string };

declare global {
  interface Window {
    __frames?: Frame[];
    __stopFrames?: () => void;
  }
}

/** Log, on every painted frame, what the pane's chat shows, when that changes. */
async function recordFrames(page: Page, paneId: string, prompt: string): Promise<void> {
  await page.evaluate(
    ({ paneId, prompt }) => {
      const frames: Frame[] = [];
      window.__frames = frames;
      const t0 = performance.now();
      let last = "";
      let running = true;
      const sample = () => {
        if (!running) return;
        const pane = document.querySelector(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
        const surface = pane?.querySelector('[data-testid="chat-starting"], [data-testid="chat-pane"]');
        const bubbles = [...(pane?.querySelectorAll('[data-testid="chat-user"]') ?? [])].filter((el) =>
          el.textContent?.includes(prompt),
        );
        const shown = bubbles.filter((el) => Number(getComputedStyle(el.closest("[data-enter]") ?? el).opacity) > 0.05);
        const note = pane?.querySelector('[class*="empty"]')?.textContent ?? null;
        const unavailable = pane?.querySelector('[data-testid="chat-unavailable"]')?.textContent ?? null;
        const state = JSON.stringify({
          surface: surface?.getAttribute("data-testid") ?? null,
          message: shown.length,
          note,
          unavailable,
        });
        if (state !== last) {
          last = state;
          frames.push({ t: Math.round(performance.now() - t0), state });
        }
        requestAnimationFrame(sample);
      };
      window.__stopFrames = () => {
        running = false;
      };
      requestAnimationFrame(sample);
    },
    { paneId, prompt },
  );
}

async function readFrames(page: Page): Promise<Array<{ t: number; surface: string | null; message: number; note: string | null; unavailable: string | null }>> {
  const frames = await page.evaluate(() => {
    window.__stopFrames?.();
    return window.__frames ?? [];
  });
  return frames.map((f) => ({ t: f.t, ...JSON.parse(f.state) }));
}

test.describe("desk chat first prompt", () => {
  test.setTimeout(180_000);

  test("the first message stays on screen once it is there", async ({ app, window, tempHome, request }) => {
    const film = new Filmstrip("desk-chat-first-prompt");
    const dir = path.join(tempHome, "fake-chat");
    const firstTranscript = path.join(dir, "first.jsonl");
    const transcript = path.join(dir, "fresh.jsonl");
    const inputLog = path.join(dir, "fresh-input.log");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "first-prompt");
    await setAgentCommand(window, "test-project", `"${FIRST_PROMPT_AGENT}" "${transcript}" "${inputLog}"`);
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${firstTranscript}" "${path.join(dir, "first-input.log")}" e2e-first-prompt`);
    await waitForVisibleSession(request, tempHome, { name: "e2e-first-prompt" });
    await window
      .locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`)
      .getByTestId("pane-chat-toggle")
      .click();

    // ⌘N from a chat opens on a fresh one, ahead of the agent.
    await window.keyboard.press("ControlOrMeta+n");
    await expect.poll(() => activePaneId(window), { timeout: 15_000 }).not.toBe(paneId);
    const freshId = await activePaneId(window);
    const fresh = window.locator(`[data-testid="workspace-pane"][data-pane-id="${freshId}"]`);
    await expect(fresh.getByTestId("chat-starting")).toBeVisible({ timeout: 20_000 });
    // The agent is up and reading its PTY before the prompt goes.
    await expect.poll(() => fs.existsSync(inputLog), { timeout: 20_000 }).toBe(true);

    const input = fresh.getByTestId("chat-composer-input");
    await input.fill(PROMPT);
    await recordFrames(window, freshId, PROMPT);
    await input.press("Enter");
    await film.shot(window, "sent");

    await expect(fresh.getByText(`received: ${PROMPT}`)).toBeVisible({ timeout: 20_000 });
    await film.shot(window, "answered");
    const frames = await readFrames(window);
    console.log(`[first-prompt] frames:\n${frames.map((f) => JSON.stringify(f)).join("\n")}`);

    const first = frames.findIndex((f) => f.message > 0);
    expect(first, "the message never showed").toBeGreaterThanOrEqual(0);
    // It shows as it is sent, ahead of the transcript and the real chat.
    expect(frames[first].surface).toBe("chat-starting");
    // Each frame after the first with the message still has it, on a chat.
    expect(frames.slice(first).filter((f) => f.message !== 1 || f.surface === null)).toEqual([]);
    // Nothing tells a user who just sent a message that there is nothing here.
    expect(frames.filter((f) => f.note?.includes("Nothing in this conversation"))).toEqual([]);
    expect(frames.filter((f) => f.unavailable)).toEqual([]);
  });
});
