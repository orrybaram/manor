import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { expect, type Locator, type Page } from "@playwright/test";

import { createWorkspace, importSeededProject, openTerminalTab } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT, FAKE_CHAT_PROMPT } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { splitPane, waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { useTheme } from "./helpers/theme";

/**
 * The chat's task view on a desk and a paired phone: the agents chip and a
 * task's card open one view without moving the chat. On a desk it's a panel
 * inside the pane that leaves the chat and other panes usable, and covers the
 * pane when it's narrow. On a phone it's one sheet, list then transcript.
 * The chip stays as "N agents done" until the next message.
 */

const AGENT_TITLE = "e2e-task-panel";

async function useManorTheme(w: Page) {
  await w.evaluate(() => window.electronAPI.theme.setSelected("Manor"));
  await w.waitForTimeout(800);
}

function agentCwd(transcriptFile: string): string {
  const pid = execFileSync("pgrep", ["-f", `fake-agent-transcript.sh.*${transcriptFile}`], { encoding: "utf-8" })
    .trim()
    .split("\n")[0];
  const out = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf-8" });
  return out.split("\n").find((l) => l.startsWith("n"))!.slice(1);
}

/** The scroll offset of the chat around a piece of its text. */
function chatScrollTop(row: Locator): Promise<number> {
  return row.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node && getComputedStyle(node).overflowY !== "auto") node = node.parentElement;
    return node?.scrollTop ?? -1;
  });
}

test.describe("chat task view", () => {
  test.setTimeout(300_000);

  test("the chip and cards open one view that leaves the chat in place", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("chat-task-panel");
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");
    const inputLogFile = path.join(chatDir, "input.log");
    const append = (file: string, line: unknown) => fs.appendFileSync(file, JSON.stringify(line) + "\n");
    const setWindow = (width: number, height: number) =>
      app.evaluate(
        ({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.unmaximize();
          win.setContentSize(size.width, size.height);
        },
        { width, height },
      );

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "task-panel");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${inputLogFile}" ${AGENT_TITLE}`);
    await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });
    const cwd = agentCwd(transcriptFile);

    await setWindow(1600, 900);
    const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
    const chat = pane.getByTestId("chat-pane");
    await useManorTheme(window);
    await pane.getByTestId("pane-chat-toggle").click();
    await expect(chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT })).toBeVisible({ timeout: 20_000 });

    const now = () => new Date().toISOString();
    const base = { cwd, gitBranch: "main", isSidechain: false };
    append(transcriptFile, {
      type: "user",
      uuid: "u-answer",
      timestamp: now(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake_question", content: "User has answered your questions." }] },
    });
    const composer = chat.getByTestId("chat-composer-input");
    await composer.fill("lose the stop hook");
    await composer.press("Enter");
    await expect(chat.getByTestId("chat-user").filter({ hasText: "lose the stop hook" })).toBeVisible({ timeout: 15_000 });

    // Each agent's own transcript lives beside the parent's, under its basename.
    const subagents = path.join(chatDir, "transcript", "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    const childFile = (agentId: string) => path.join(subagents, `agent-${agentId}.jsonl`);
    const child = (agentId: string, uuid: string, role: "user" | "assistant", content: unknown) =>
      append(childFile(agentId), {
        ...base,
        type: role,
        uuid,
        isSidechain: true,
        agentId,
        timestamp: now(),
        message: { id: uuid, role, model: "claude-opus-5-5", content },
      });
    const agents = [
      { toolId: "toolu_one", agentId: "aone", type: "Explore", title: "Audit toast call sites" },
      { toolId: "toolu_two", agentId: "atwo", type: "general-purpose", title: "Run the toast e2e specs" },
      { toolId: "toolu_three", agentId: "athree", type: "Explore", title: "Find prior art in sonner" },
    ];
    for (const a of agents) {
      child(a.agentId, `${a.agentId}-u`, "user", `Brief for ${a.title}`);
      child(a.agentId, `${a.agentId}-a`, "assistant", [{ type: "text", text: `Findings from ${a.title}` }]);
      append(transcriptFile, {
        ...base,
        type: "assistant",
        uuid: `a-${a.toolId}`,
        timestamp: now(),
        message: {
          id: `msg-${a.toolId}`,
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: null,
          content: [{ type: "tool_use", id: a.toolId, name: "Agent", input: { description: a.title, subagent_type: a.type, prompt: "…", run_in_background: true } }],
        },
      });
      append(transcriptFile, {
        ...base,
        type: "user",
        uuid: `u-${a.toolId}`,
        timestamp: now(),
        toolUseResult: { isAsync: true, status: "async_launched", agentId: a.agentId },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: a.toolId, content: "Async agent launched successfully." }] },
      });
    }
    // Enough chat that it scrolls, so the panel opening could move it.
    for (let i = 0; i < 12; i++) {
      append(transcriptFile, {
        ...base,
        type: "assistant",
        uuid: `a-long-${i}`,
        timestamp: now(),
        message: { id: `msg-long-${i}`, role: "assistant", model: "claude-opus-5-5", stop_reason: null, content: [{ type: "text", text: `While they run, here is paragraph ${i} of what I've read so far about how the deck measures its toasts and why a wrapped one overlaps the next.` }] },
      });
    }

    const chip = chat.getByTestId("chat-agents-chip");
    const panel = chat.getByTestId("chat-task-panel");
    const lastLine = chat.getByText("here is paragraph 11");
    await expect(chip).toHaveText("3 agents", { timeout: 20_000 });
    await expect(lastLine).toBeInViewport({ timeout: 10_000 });
    await film.shot(window, "desk-dark-chat");

    // 1. The chip opens the newest running agent; the chat stays at its bottom.
    await chip.click();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Find prior art in sonner");
    await expect(panel.getByText("Findings from Find prior art in sonner")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId("chat-task-panel-count")).toHaveText("3 of 3");
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await expect(lastLine).toBeInViewport({ timeout: 5_000 });
    await expect(chat.getByTestId("chat-composer")).toBeVisible();
    await film.shot(window, "desk-dark-panel");

    // 2. Arrows switch agents without closing; new output is followed.
    await panel.getByTestId("chat-task-panel-previous").click();
    await expect(panel).toContainText("Run the toast e2e specs");
    await expect(panel.getByText("Findings from Run the toast e2e specs")).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < 30; i++) {
      child("atwo", `atwo-more-${i}`, "assistant", [{ type: "text", text: `Spec ${i} of 30 passed.` }]);
    }
    await expect(panel.getByText("Spec 29 of 30 passed.")).toBeInViewport({ timeout: 15_000 });
    await film.shot(window, "desk-dark-panel-following");

    // Scrolled up, new output leaves your place alone.
    const transcript = panel.getByTestId("chat-task-transcript");
    await transcript.hover();
    await window.mouse.wheel(0, -300);
    await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
    const scrolledTo = await transcript.evaluate((el) => el.scrollTop);
    child("atwo", "atwo-late", "assistant", [{ type: "text", text: "One more spec passed." }]);
    await expect(panel.getByText("One more spec passed.")).toBeAttached({ timeout: 15_000 });
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(scrolledTo);

    // Escape closes it after a click in the chat too, which takes focus off everything.
    await lastLine.click();
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await chip.click();
    await expect(panel).toBeVisible();

    // 3. Escape closes it, even from the composer, and the composer stays usable with it open.
    await composer.click();
    await composer.fill("still typing");
    await expect(panel).toBeVisible();
    await composer.press("Escape");
    await expect(panel).toBeHidden();
    await expect(composer).toBeFocused();
    await composer.fill("");

    // 4. A card opens the same view on its agent, and leaves a scrolled chat in place.
    const card = chat.locator('[data-task-id="toolu_one"]');
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await window.waitForTimeout(300);
    const before = await card.boundingBox();
    await card.getByRole("button").first().click();
    await expect(panel).toContainText("Audit toast call sites");
    await expect(card).toHaveAttribute("data-viewed", "true");
    const after = await card.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(4);
    await film.shot(window, "desk-dark-card-opens-panel");
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // The chip leaves a scrolled chat in place too.
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await window.waitForTimeout(300);
    const beforeChip = await card.boundingBox();
    await chip.click();
    await expect(panel).toBeVisible();
    const afterChip = await card.boundingBox();
    expect(Math.abs(afterChip!.y - beforeChip!.y)).toBeLessThan(4);

    // Docked beside the chat, in light.
    await useTheme(window, "Catppuccin Latte");
    await window.waitForTimeout(500);
    await film.shot(window, "desk-light-docked");
    await useManorTheme(window);
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // 5. Beside a split: inside the pane, and the neighbour isn't dimmed or blocked.
    const { paneId: neighbourId } = await splitPane(request, tempHome, { paneId, direction: "horizontal" });
    const neighbour = window.locator(`[data-testid="workspace-pane"][data-pane-id="${neighbourId}"]`);
    await expect(neighbour).toBeVisible({ timeout: 15_000 });
    await chip.click();
    await expect(panel).toBeVisible();
    const paneBox = await pane.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1);
    await neighbour.click();
    await expect(panel).toBeVisible();
    await film.shot(window, "desk-dark-split");

    // 6. A narrow pane: the panel covers it, with a back arrow.
    await setWindow(1000, 800);
    await expect(panel.getByTestId("chat-task-panel-back")).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByTestId("chat-task-panel-close")).toBeHidden();
    const narrowPane = await pane.boundingBox();
    const narrowPanel = await panel.boundingBox();
    expect(Math.abs(narrowPanel!.width - narrowPane!.width)).toBeLessThan(40);
    await film.shot(window, "desk-dark-narrow");
    await panel.getByTestId("chat-task-panel-back").click();
    await expect(panel).toBeHidden();
    await expect(composer).toBeVisible();
    await setWindow(1600, 900);

    // 7. Light.
    await useTheme(window, "Catppuccin Latte");
    await window.waitForTimeout(800);
    await chip.click();
    await expect(panel).toBeVisible();
    await film.shot(window, "desk-light-panel");
    await window.keyboard.press("Escape");
    await useManorTheme(window);

    // 8. The phone: list, then transcript, in one sheet.
    const device = await pairBrowser(window, { label: "task panel phone" });
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
      await expect(phoneChat).toBeVisible({ timeout: 20_000 });
      const phoneChip = phoneChat.getByTestId("chat-agents-chip");
      await expect(phoneChip).toHaveText("3 agents", { timeout: 15_000 });
      // Scrolled up, the sheet and everything in it leave the chat's place alone.
      const phoneRow = phoneChat.getByText("here is paragraph 5");
      await phoneRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      const phoneScroll = await chatScrollTop(phoneRow);
      await phoneChip.tap();
      const sheet = page.getByTestId("chat-agents-sheet");
      await expect(sheet.getByTestId("chat-agent-row")).toHaveCount(3);
      await film.shot(page, "phone-dark-list");
      await sheet.getByTestId("chat-agent-row").first().tap();
      await expect(sheet.getByText("Findings from Audit toast call sites")).toBeVisible({ timeout: 15_000 });
      await film.shot(page, "phone-dark-transcript");
      await sheet.getByTestId("chat-agents-back").tap();
      await expect(sheet.getByTestId("chat-agent-row")).toHaveCount(3);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      expect(await chatScrollTop(phoneRow)).toBe(phoneScroll);
      // The phone paints the light palette itself, as `useTheme` does where the theme list isn't loaded.
      await useTheme(page, "Catppuccin Latte");
      await phoneChip.tap();
      await expect(sheet.getByTestId("chat-agent-row")).toHaveCount(3);
      await page.waitForTimeout(500);
      await film.shot(page, "phone-light-list");
      await sheet.getByTestId("chat-agent-row").first().tap();
      await expect(sheet.getByText("Findings from Audit toast call sites")).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(500);
      await film.shot(page, "phone-light-transcript");
      await page.keyboard.press("Escape");
    } finally {
      await client.close();
    }

    // 9. All finished: the chip stays until the next message.
    for (const a of agents) {
      append(transcriptFile, {
        type: "user",
        uuid: `n-${a.toolId}`,
        timestamp: now(),
        message: {
          role: "user",
          content: `<task-notification>\n<task-id>${a.agentId}</task-id>\n<tool-use-id>${a.toolId}</tool-use-id>\n<status>completed</status>\n<summary>${a.title} finished</summary>\n</task-notification>`,
        },
      });
    }
    await expect(chip).toHaveText("3 agents done", { timeout: 20_000 });
    await film.shot(window, "desk-dark-agents-done");
    await chip.click();
    await expect(panel).toBeVisible();
    await film.shot(window, "desk-dark-done-panel");
    await useTheme(window, "Catppuccin Latte");
    await window.waitForTimeout(500);
    await film.shot(window, "desk-light-done-panel");
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await film.shot(window, "desk-light-agents-done");
    await useManorTheme(window);
    await chip.click();
    await expect(panel).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(composer).toBeFocused();
    await film.shot(window, "desk-dark-after-escape");
    // The fake agent's timestamps are whole seconds: this message must land in a later one.
    await window.waitForTimeout(1100);
    await composer.fill("thanks, carry on");
    await composer.press("Enter");
    await expect(chat.getByTestId("chat-user").filter({ hasText: "thanks, carry on" })).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveCount(0, { timeout: 15_000 });
    await film.shot(window, "desk-dark-chip-gone");
  });
});
