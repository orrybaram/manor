import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { expect, type Locator, type Page } from "@playwright/test";

import { createWorkspace, importSeededProject, openTerminalTab } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT, FAKE_CHAT_PROMPT } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { useTheme } from "./helpers/theme";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * The chat's session info (#589), on the desk and on a paired phone: the
 * branch, model and effort chips, the branch mismatch flag, "Thought for Ns",
 * the live line and the turn divider in Manor's voice, and the agents chip
 * with its list of background agents.
 *
 * The session is the transcript agent (`helpers/fake-agent-transcript.sh`).
 * "lose the stop hook" starts a turn that never ends on its own; the test then
 * writes the turn's lines into the transcript the way Claude Code does.
 */

const AGENT_TITLE = "e2e-session-info";

/** Manor's own theme, which `useTheme` doesn't offer. */
async function useManorTheme(w: Page) {
  await w.evaluate(() => window.electronAPI.theme.setSelected("Manor"));
  await w.waitForTimeout(800);
}

function paneLocator(page: Page, paneId: string) {
  return page.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
}

function agentCwd(transcriptFile: string): string {
  const pid = execFileSync("pgrep", ["-f", `fake-agent-transcript.sh.*${transcriptFile}`], { encoding: "utf-8" })
    .trim()
    .split("\n")[0];
  const out = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf-8" });
  return out.split("\n").find((l) => l.startsWith("n"))!.slice(1);
}

/** Opens and shoots the agents list, then closes it again. */
async function shootAgentsList(film: Filmstrip, page: Page, chat: Locator, name: string, phone: boolean) {
  await chat.getByTestId("chat-agents-chip").click();
  const list = page.getByTestId(phone ? "chat-agents-sheet" : "chat-agents-popover");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await expect(list.getByTestId("chat-agent-row")).toHaveCount(2);
  await film.shot(page, name);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
}

test.describe("chat session info", () => {
  test.setTimeout(300_000);

  test("branch, model, effort, thinking and turn time, and background agents, on the desk and a phone", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("chat-session-info");
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");
    const inputLogFile = path.join(chatDir, "input.log");
    const append = (line: unknown) => fs.appendFileSync(transcriptFile, JSON.stringify(line) + "\n");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "session-info");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${inputLogFile}" ${AGENT_TITLE}`);
    await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });
    const cwd = agentCwd(transcriptFile);
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();

    const pane = paneLocator(window, paneId);
    const chat = pane.getByTestId("chat-pane");
    await useManorTheme(window);
    await pane.getByTestId("pane-chat-toggle").click();
    await expect(chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT })).toBeVisible({ timeout: 20_000 });

    // The fake agent opens on an unanswered picker, which keeps the live line
    // away: answer it, as Claude Code writes the answer.
    append({
      type: "user",
      uuid: "u-answer",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake_question", content: "User has answered your questions." }] },
    });

    // A turn that stays open.
    await chat.getByTestId("chat-composer-input").fill("lose the stop hook");
    await chat.getByTestId("chat-composer-input").press("Enter");
    await expect(chat.getByTestId("chat-user").filter({ hasText: "lose the stop hook" })).toBeVisible({ timeout: 15_000 });

    const base = { cwd, gitBranch: branch, isSidechain: false };
    const now = () => new Date().toISOString();
    const assistant = (uuid: string, msgId: string, content: unknown[], extra: Record<string, unknown> = {}) =>
      append({
        ...base,
        type: "assistant",
        uuid,
        timestamp: now(),
        effort: "high",
        ...extra,
        message: { id: msgId, role: "assistant", model: "claude-opus-5-5", content, stop_reason: extra.stop_reason ?? null },
      });

    // Thinking, then text, then two background agents, then more text.
    assistant("a-think", "msg-1", [{ type: "thinking", thinking: "", signature: "x" }], { thinkingDurationMs: 4200 });
    assistant("a-text", "msg-1", [
      { type: "text", text: "Yes. Every transcript line already records the branch, and assistant lines carry the model and effort." },
    ]);
    const agents = [
      { id: "toolu_bg_one", type: "Explore", title: "Find every place the status line reads the workspace" },
      { id: "toolu_bg_two", type: "general-purpose", title: "Draft the transcript reader tests" },
    ];
    for (const a of agents) {
      assistant(`a-${a.id}`, "msg-2", [
        {
          type: "tool_use",
          id: a.id,
          name: "Agent",
          input: { description: a.title, subagent_type: a.type, prompt: "…", run_in_background: true },
        },
      ]);
      append({
        ...base,
        type: "user",
        uuid: `u-${a.id}`,
        timestamp: now(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: a.id, content: [{ type: "text", text: "Async agent launched successfully." }] }] },
      });
    }
    assistant("a-think-2", "msg-3", [{ type: "thinking", thinking: "", signature: "x" }], { thinkingDurationMs: 5100 });
    assistant("a-text-2", "msg-3", [
      { type: "text", text: "The status line reads the active workspace from the project store, so the live branch is one field away. Two agents are mapping the rest." },
    ]);

    // 1. Desk, working: chips, thought lines, live line, agents chip.
    const statusLine = chat.getByTestId("chat-status-line");
    await expect(chat.getByTestId("chat-branch-chip")).toBeVisible({ timeout: 15_000 });
    await expect(statusLine).toContainText("Opus 5.5");
    await expect(statusLine).toContainText("high");
    await expect(chat.getByTestId("chat-agents-chip")).toHaveText(/2 agents/, { timeout: 15_000 });
    await expect(chat.getByText("Thought for 4s")).toBeVisible();
    await expect(chat.getByTestId("chat-thinking")).toBeVisible({ timeout: 10_000 });
    await film.shot(window, "desk-dark-working");
    const firstVerb = await chat.getByTestId("chat-thinking").textContent();
    await window.waitForTimeout(3000);
    const secondVerb = await chat.getByTestId("chat-thinking").textContent();
    expect(secondVerb).not.toBe(firstVerb);
    await film.shot(window, "desk-dark-working-later");
    await shootAgentsList(film, window, chat, "desk-dark-agents-list", false);

    // 2. A row jumps to its card.
    await chat.getByTestId("chat-agents-chip").click();
    await window.getByTestId("chat-agent-row").first().click();
    await expect(chat.locator('[data-task-id="toolu_bg_one"]')).toBeInViewport({ timeout: 10_000 });
    await film.shot(window, "desk-dark-agent-revealed");

    // 3. The turn ends with both agents still out.
    assistant("a-end", "msg-4", [{ type: "text", text: "I'll pick their results up when they report." }], { stop_reason: "end_turn" });
    append({ ...base, type: "system", subtype: "turn_duration", uuid: "s-turn-1", timestamp: now(), durationMs: 134_000, messageCount: 12, pendingBackgroundAgentCount: 2 });
    const divider = chat.getByTestId("chat-turn-end");
    await expect(divider).toContainText("2m 14s", { timeout: 15_000 });
    await expect(divider).toContainText("2 background agents still running");
    await divider.scrollIntoViewIfNeeded();
    await film.shot(window, "desk-dark-turn-ended");

    // 4. The agent's transcript names another branch.
    assistant("a-elsewhere", "msg-5", [{ type: "text", text: "Switched to look at the old fix." }], { gitBranch: "fix/old-branch", stop_reason: "end_turn" });
    const branchChip = chat.getByTestId("chat-branch-chip");
    await expect(branchChip).toContainText("≠", { timeout: 15_000 });
    await branchChip.click();
    await expect(window.getByText("fix/old-branch")).toBeVisible({ timeout: 10_000 });
    await film.shot(window, "desk-dark-branch-mismatch");
    await window.keyboard.press("Escape");

    // 5. Light.
    await useTheme(window, "Catppuccin Latte");
    await film.shot(window, "desk-light");
    await shootAgentsList(film, window, chat, "desk-light-agents-list", false);

    // 6. The phone.
    await useManorTheme(window);
    const device = await pairBrowser(window, { label: "session info phone" });
    await closeSettings(window);
    const client = await openWebApp(device.link, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });
    try {
      const page = client.page;
      await expect(page.getByTestId("phone-top-bar")).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => activePaneId(page), { timeout: 15_000 }).toBe(paneId);
      const phoneChat = paneLocator(page, paneId).getByTestId("chat-pane");
      await expect(phoneChat).toBeVisible({ timeout: 20_000 });
      await expect(phoneChat.getByTestId("chat-turn-end")).toBeVisible({ timeout: 15_000 });
      await expect(phoneChat.getByTestId("chat-agents-chip")).toHaveText(/2 agents/);
      await film.shot(page, "phone-dark");
      await shootAgentsList(film, page, phoneChat, "phone-dark-agents-list", true);
      await phoneChat.getByTestId("chat-branch-chip").click();
      await expect(page.getByText("fix/old-branch")).toBeVisible({ timeout: 10_000 });
      await film.shot(page, "phone-dark-branch-sheet");
      await page.keyboard.press("Escape");

      await useTheme(window, "Catppuccin Latte");
      await page.waitForTimeout(1500);
      await film.shot(page, "phone-light");
      await shootAgentsList(film, page, phoneChat, "phone-light-agents-list", true);
    } finally {
      await client.close();
    }
  });
});
