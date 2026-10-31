import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT, FAKE_CHAT_PROMPT } from "./helpers/fake-agent";
import { header as fileHeader } from "./helpers/file-pane";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { useTheme } from "./helpers/theme";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * The desk chat's composer and what it shows of a prompt: a paste folds to a
 * "Pasted N lines" row, Enter sends and Shift+Enter breaks the line, an image
 * pastes as a thumbnail and sends as its path, one round button is Stop or Send, a prompt sent
 * mid-turn shows as queued until its line lands, and an edit card opens its
 * file beside the chat.
 *
 * The session is the transcript agent (`helpers/fake-agent-transcript.sh`).
 * It writes a sent prompt's line the moment it reads it, so to hold a prompt
 * in the queue the test stops the agent's process and writes the queued
 * prompt's line itself.
 */

const ENTER = "\r";

function paneLocator(page: Page, paneId: string) {
  return page.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
}

function inputLog(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").replace(/\n/g, ENTER) : "";
}

function agentPid(transcriptFile: string): number {
  const out = execFileSync("pgrep", ["-f", `fake-agent-transcript.sh.*${transcriptFile}`], { encoding: "utf-8" });
  return Number(out.trim().split("\n")[0]);
}

function cwdOf(pid: number): string {
  const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf-8" });
  return out.split("\n").find((l) => l.startsWith("n"))!.slice(1);
}

test.describe("desk chat composer", () => {
  test.setTimeout(240_000);

  test("folds a paste, sends on Enter, pastes an image, queues mid-turn, and opens an edit", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("desk-chat-composer");
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");
    const inputLogFile = path.join(chatDir, "input.log");
    const append = (line: unknown) => fs.appendFileSync(transcriptFile, JSON.stringify(line) + "\n");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "chat-composer");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${inputLogFile}" e2e-composer`);
    await waitForVisibleSession(request, tempHome, { name: "e2e-composer" });
    const pid = agentPid(transcriptFile);
    const cwd = cwdOf(pid);

    const pane = paneLocator(window, paneId);
    const chat = pane.getByTestId("chat-pane");
    const input = chat.getByTestId("chat-composer-input");
    await useTheme(window, "Catppuccin Mocha");
    await pane.getByTestId("pane-chat-toggle").click();
    await expect(chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT })).toBeVisible({ timeout: 20_000 });

    // 0. Typed text starts on the transcript's left edge.
    const textLeft = (el: Element) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft);
    const entriesLeft = await chat.locator('[class*="entries"]').first().evaluate(textLeft);
    expect(await input.evaluate(textLeft)).toBeCloseTo(entriesLeft, 0);
    await film.shot(window, "composer-aligned");

    // 1. A prompt with a paste: the paste folds, its tags never show.
    append({
      type: "user",
      uuid: "u-pasted",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content:
          'look at this:\n\n<pasted_content id="db6d">\n[oh-my-zsh] Would you like to update? [Y/n]\nzsh: command not found: laude\n</pasted_content id="db6d">\n\nany fix?',
      },
    });
    const pasted = chat.getByTestId("chat-pasted");
    await expect(pasted).toHaveText(/Pasted 2 lines/, { timeout: 15_000 });
    await expect(chat.getByTestId("chat-user").last()).not.toContainText("pasted_content");
    await film.shot(window, "paste-folded");
    await pasted.locator("summary").click();
    await expect(pasted).toContainText("command not found: laude");
    await film.shot(window, "paste-open");

    // 2. An edit to a workspace file: its card opens the file beside the chat.
    const file = path.join(cwd, "chat-edit-demo.ts");
    fs.writeFileSync(file, "const a = 1;\nconst b = 3;\nconst c = 3;\n");
    const toolId = "toolu_fake_edit";
    append({
      type: "assistant",
      uuid: "a-edit",
      cwd,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolId, name: "Edit", input: { file_path: file, old_string: "b = 2", new_string: "b = 3" } }],
      },
    });
    append({
      type: "user",
      uuid: "u-edit",
      cwd,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "Updated" }] },
      toolUseResult: {
        filePath: file,
        structuredPatch: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 3;"] },
        ],
      },
    });
    const open = chat.getByTestId("chat-edit-open");
    await expect(open).toHaveText("Open in Manor", { timeout: 15_000 });
    await film.shot(window, "edit-card");
    await open.click();
    await expect(fileHeader(window)).toContainText("chat-edit-demo.ts", { timeout: 15_000 });
    await film.shot(window, "edit-opened");

    // 3. Shift+Enter breaks the line; Enter sends.
    await input.click();
    await window.keyboard.type("first");
    await window.keyboard.press("Shift+Enter");
    await window.keyboard.type("second");
    await expect(input).toHaveValue("first\nsecond");
    expect(inputLog(inputLogFile)).not.toContain("first");
    await input.fill("sent with enter");
    await input.press("Enter");
    await expect.poll(() => inputLog(inputLogFile), { timeout: 15_000 }).toContain("sent with enter" + ENTER);
    await expect(input).toHaveValue("");

    // 4. A pasted image shows as a thumbnail, and sends as its path after the text.
    await input.click();
    await window.evaluate(async () => {
      const el = document.activeElement as HTMLTextAreaElement;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 120;
      const ctx = canvas.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 120, 120);
      g.addColorStop(0, "#f5c2e7");
      g.addColorStop(1, "#74c7ec");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 120, 120);
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
      const data = new DataTransfer();
      data.items.add(new File([blob], "shot.png", { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const thumbs = chat.getByTestId("image-attachment");
    await expect(thumbs).toHaveCount(1);
    await expect(chat.locator("[data-uploading]")).toHaveCount(0, { timeout: 15_000 });
    await expect(input).toHaveValue("");
    await input.fill("what is this");
    await film.shot(window, "image-attached");
    await useTheme(window, "Catppuccin Latte");
    await film.shot(window, "image-attached-light");
    await useTheme(window, "Catppuccin Mocha");
    await input.press("Enter");
    await expect.poll(() => inputLog(inputLogFile), { timeout: 15_000 }).toMatch(/what is this \/\S+\.png\r/);
    const imagePath = inputLog(inputLogFile).match(/what is this (\/\S+\.png)\r/)![1];
    expect(fs.existsSync(imagePath)).toBe(true);
    await expect(thumbs).toHaveCount(0);
    await expect(input).toHaveValue("");

    // 5. Mid-turn: one round button, Stop while empty and Send once typed.
    await input.fill("lose the stop hook");
    await input.press("Enter");
    const stop = chat.getByTestId("chat-stop");
    const send = chat.getByTestId("chat-send");
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await expect(send).toHaveCount(0);
    await film.shot(window, "busy-stop");
    await input.fill("and also this");
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);

    // 6. Sent mid-turn, it shows as queued until its line lands. The agent is
    // stopped so it can't write the line; the test writes it, as Claude Code
    // does once the model can read the prompt. (A stopped and continued bash
    // `read` gives up, so the agent isn't relied on after this.)
    process.kill(pid, "SIGSTOP");
    try {
      await input.press("Enter");
      const queued = chat.getByTestId("chat-queued");
      await expect(queued).toContainText("and also this", { timeout: 10_000 });
      await film.shot(window, "queued");
      append({
        type: "attachment",
        uuid: "a-queued",
        timestamp: new Date().toISOString(),
        attachment: { type: "queued_command", commandMode: "prompt", prompt: "and also this" },
      });
      await expect(chat.getByTestId("chat-user").filter({ hasText: "and also this" })).toBeVisible({ timeout: 15_000 });
      await expect(queued).toHaveCount(0);
    } finally {
      process.kill(pid, "SIGCONT");
    }
    await film.shot(window, "queued-landed");
  });
});
