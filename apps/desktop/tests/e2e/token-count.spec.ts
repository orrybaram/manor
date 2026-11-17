import fs from "fs";
import path from "path";

import type { Page } from "@playwright/test";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { useTheme } from "./helpers/theme";

/**
 * The token tally, end to end (#695): a Claude-kind agent's turn ends and
 * Today's Tokens rises by exactly the turn's fresh tokens. A message's usage
 * repeated on several lines counts once (its later, larger output tops it
 * up), and cache reads are left out. Trophy Room › Stats then shows the
 * Tokens row, shot in dark and light.
 *
 * The agent is the transcript agent (`helpers/fake-agent-transcript.sh`): the
 * test writes the turn's usage lines into its transcript, then types a line,
 * which the agent answers and ends with its Stop hook — the tally's trigger.
 */

const AGENT_TITLE = "e2e-token-count";
const SHOTS = path.join(__dirname, "artifacts", "token-count");

/** One assistant line, as Claude Code writes one per content block. */
function assistantLine(
  uuid: string,
  msgId: string,
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number },
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      id: msgId,
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: `block ${uuid}` }],
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        output_tokens: usage.output,
      },
    },
  });
}

// msg-a: three lines, the last reporting more output (40 → 90).
// msg-b: one line. Cache reads (50,000 and 51,243) never count.
const MSG_A_FIRST = { input: 3, cacheWrite: 1200, cacheRead: 50_000, output: 40 };
const MSG_A_LAST = { ...MSG_A_FIRST, output: 90 };
const MSG_B = { input: 5, cacheWrite: 0, cacheRead: 51_243, output: 12 };
/** (3 + 1200 + 90) + (5 + 0 + 12). */
const HAND_SUM = 1310;

interface Summary {
  today: Record<string, number | undefined>;
}

function summary(window: Page): Promise<Summary> {
  return window.evaluate(() => window.electronAPI.stats.getSummary()) as Promise<Summary>;
}

/** Opens Trophy Room › Stats from the palette and shoots its table. */
async function shootStats(window: Page, file: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.locator("[cmdk-input]")).toBeFocused();
  await window.keyboard.type("Stats");
  await window.keyboard.press("Enter");
  const tokens = window.getByRole("row").filter({ has: window.getByRole("rowheader", { name: /^Tokens/ }) });
  await expect(tokens).toBeVisible({ timeout: 10_000 });
  // Today, 7 Days and All Time: compact, with the exact count on hover.
  const cells = tokens.getByRole("cell");
  await expect(cells).toHaveText(["1.3k", "1.3k", "1.3k"]);
  for (let i = 0; i < 3; i++) await expect(cells.nth(i)).toHaveAttribute("title", /^1[,.\u202f\u00a0]?310$/);
  const table = window.locator("table").filter({ has: tokens });
  await table.scrollIntoViewIfNeeded();
  await table.screenshot({ path: path.join(SHOTS, file), animations: "disabled" });
  await expect(async () => {
    await window.keyboard.press("Escape");
    await expect(window.locator("[cmdk-input]")).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

test.describe("token count", () => {
  test.setTimeout(180_000);

  test("a Claude turn's fresh tokens reach Today's Tokens, and Stats shows the row", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    const dir = path.join(tempHome, "fake-chat");
    const transcript = path.join(dir, "transcript.jsonl");

    expect((await summary(window)).today.tokens ?? 0).toBe(0);

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "token-count");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${transcript}" "${path.join(dir, "input.log")}" ${AGENT_TITLE}`);
    await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });

    // The turn's usage, as Claude writes it.
    for (const line of [
      assistantLine("a-1", "msg-a", MSG_A_FIRST),
      assistantLine("a-2", "msg-a", MSG_A_FIRST),
      assistantLine("a-3", "msg-a", MSG_A_LAST),
      assistantLine("b-1", "msg-b", MSG_B),
    ]) {
      fs.appendFileSync(transcript, `${line}\n`);
    }

    // A typed line: the agent answers it and ends the turn with Stop.
    await runInTerminal(window, "count my tokens");
    await expect
      // Well inside the 60s sweep, so it's the turn's Stop that counted it.
      .poll(async () => (await summary(window)).today.tokens ?? 0, { timeout: 10_000 })
      .toBe(HAND_SUM);

    await useTheme(window, "Catppuccin Mocha");
    await shootStats(window, "stats-dark.png");
    await useTheme(window, "Catppuccin Latte");
    await shootStats(window, "stats-light.png");

    // Nothing counts twice: after a full 60s sweep there is still nothing new.
    await window.waitForTimeout(65_000);
    expect((await summary(window)).today.tokens).toBe(HAND_SUM);
  });
});
