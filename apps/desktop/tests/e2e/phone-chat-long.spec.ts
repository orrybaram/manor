import fs from "fs";
import path from "path";
import { expect, type Page } from "@playwright/test";

import { createWorkspace, importSeededProject, openTerminalTab } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT, FAKE_CHAT_REPLY } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { relayTest as test } from "./helpers/relay-fixture";
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * A phone on a long Claude session: the chat mounts only its newest items,
 * scrolling up mounts earlier ones without moving what the user is reading,
 * entries landing meanwhile leave the view alone, and the bottom drops back
 * to the newest items and follows again.
 *
 * Same setup as `phone-chat.spec.ts`: the transcript agent in a desk pane,
 * a 390×844 touch phone paired through a local relay. The agent starts from
 * a seeded session of `TURNS` turns; live entries are appended to the
 * transcript file, which the mirror tails as it would Claude's.
 *
 * It also prints what opening the chat costs under a 4× CPU throttle, the
 * number to compare across builds.
 */

const AGENT_TITLE = "e2e-long-chat-agent";
/** Turns in the seeded session; four chat items each. */
const TURNS = 400;
/** The window's size (`chat-window.ts`), plus the thinking line. */
const MAX_MOUNTED = 151;
/** A place that holds may still round by a pixel. */
const JUMP_SLOP_PX = 2;

const prompt = (i: number) => `Turn ${i}: please look at part ${i} of the codebase.`;

/** One seeded turn in Claude Code's JSONL: a prompt, a reply, a command, a wrap-up. */
function seedTurn(i: number): string[] {
  const ts = "2026-10-28T00:00:00.000Z";
  const reply = [
    `Part ${i}: the **stream** reads complete lines only, so a partial line is read again.`,
    "",
    "- `TranscriptStream` holds the offset",
    "- the renderer upserts by id",
    "",
    "```ts",
    "const index = entries.findIndex((e) => e.id === entry.id);",
    "```",
  ].join("\n");
  return [
    { type: "user", uuid: `u${i}`, timestamp: ts, message: { role: "user", content: prompt(i) } },
    { type: "assistant", uuid: `a${i}`, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: reply }] } },
    {
      type: "assistant",
      uuid: `t${i}`,
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `pnpm test part-${i}` } }] },
    },
    {
      type: "user",
      uuid: `r${i}`,
      timestamp: ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "ok\n".repeat(20) }] },
    },
    { type: "assistant", uuid: `b${i}`, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: `Done with part ${i}.` }] } },
  ].map((line) => JSON.stringify(line));
}

/** A turn landing while the phone watches, appended as Claude would. */
function appendTurn(transcript: string, name: string): void {
  const ts = new Date().toISOString();
  const lines = [
    { type: "user", uuid: `u-${name}`, timestamp: ts, message: { role: "user", content: name } },
    { type: "assistant", uuid: `a-${name}`, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: `reply to ${name}` }] } },
  ];
  fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l) + "\n").join(""));
}

type Geometry = { mounted: number; scrollTop: number; scrollHeight: number; clientHeight: number };

/** The chat's scroller (the scrolling parent of its entry list) as numbers. */
function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    // A user bubble's row, its entry, then the entry list.
    const content = document.querySelector('[data-testid="chat-user"]')!.parentElement!.parentElement!.parentElement!;
    const scroller = content.parentElement!;
    return {
      mounted: content.children.length,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  });
}

/**
 * Scroll the chat by `dy` and let it settle. Returns how far the entry at the
 * top of the view moved, against how far the scroll asked it to: equal when
 * the user's place held, whatever mounted above it.
 */
function scrollBy(page: Page, dy: number): Promise<{ moved: number; asked: number; mounted: number }> {
  return page.evaluate(async (dy) => {
    const content = document.querySelector('[data-testid="chat-user"]')!.parentElement!.parentElement!.parentElement!;
    const scroller = content.parentElement!;
    const view = scroller.getBoundingClientRect();
    const ref = [...content.children].find((el) => el.getBoundingClientRect().bottom > view.top + 1)!;
    const before = ref.getBoundingClientRect().top;
    const from = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const asked = Math.max(-from, Math.min(dy, max - from));
    scroller.scrollTop = from + dy;
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => requestAnimationFrame(r));
    return { moved: before - ref.getBoundingClientRect().top, asked, mounted: content.children.length };
  }, dy);
}

/** The top of the first entry in view, for "did what I'm reading move". */
function topInView(page: Page): Promise<{ text: string; top: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('[data-testid="chat-user"]')!.parentElement!.parentElement!.parentElement!;
    const view = content.parentElement!.getBoundingClientRect();
    const ref = [...content.children].find((el) => el.getBoundingClientRect().bottom > view.top + 1)!;
    return { text: (ref.textContent ?? "").slice(0, 60), top: ref.getBoundingClientRect().top };
  });
}

test.describe("phone chat on a long session", () => {
  test.setTimeout(300_000);

  test("mounts the newest items, loads earlier ones in place, and drops back at the bottom", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("phone-chat-long");
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");
    const seedFile = path.join(chatDir, "seed.jsonl");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(seedFile, Array.from({ length: TURNS }, (_, i) => seedTurn(i)).flat().join("\n") + "\n");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "phone-chat-long");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(
      window,
      `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${path.join(chatDir, "input.log")}" ${AGENT_TITLE} "${seedFile}"`,
    );
    await waitForVisibleSession(request, tempHome, { name: AGENT_TITLE });

    const device = await pairBrowser(window, { label: "long chat phone" });
    await closeSettings(window);
    const client = await openWebApp(device.link, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });

    try {
      const page = client.page;
      await expect.poll(() => activePaneId(page), { timeout: 30_000 }).toBe(paneId);
      const chat = page.getByTestId("chat-pane");
      const newestReply = chat.getByTestId("chat-assistant").filter({ hasText: FAKE_CHAT_REPLY });
      await expect(newestReply).toBeVisible({ timeout: 30_000 });

      // ── What opening costs, on a phone-speed CPU ────────────────────
      const cdp = await page.context().newCDPSession(page);
      await page.addInitScript(() => {
        const tasks: number[] = [];
        (window as unknown as { __longTasks: number[] }).__longTasks = tasks;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) tasks.push(e.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const t0 = Date.now();
      await page.reload();
      await expect(newestReply).toBeVisible({ timeout: 60_000 });
      const openMs = Date.now() - t0;
      const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      const opened = await geometry(page);
      const report = [
        `── phone chat, ${TURNS} turns, 4× CPU throttle ──`,
        `  reload → newest reply   ${openMs}ms`,
        `  long tasks              ${longTasks.length}, ${Math.round(longTasks.reduce((a, b) => a + b, 0))}ms total, worst ${Math.round(Math.max(0, ...longTasks))}ms`,
        `  items mounted           ${opened.mounted}`,
        `  scroll height           ${opened.scrollHeight}px`,
      ].join("\n");
      console.log(report);
      film.write("open-cost.txt", report + "\n");

      // 1. It opens at the bottom with only the newest items.
      expect(opened.mounted).toBeLessThanOrEqual(MAX_MOUNTED);
      expect(opened.scrollHeight - opened.scrollTop - opened.clientHeight).toBeLessThan(48);
      await expect(chat.getByTestId("chat-user").filter({ hasText: prompt(TURNS - 1) })).toHaveCount(1);
      await expect(chat.getByTestId("chat-user").filter({ hasText: prompt(0) })).toHaveCount(0);
      await film.shot(page, "open-at-bottom");

      // 2. Up to the first prompt. Each step that mounts earlier items
      // leaves the entry in view where the scroll alone put it.
      let loads = 0;
      let worstJump = 0;
      let mounted = opened.mounted;
      for (let step = 0; step < 400; step++) {
        const r = await scrollBy(page, -900);
        if (r.mounted > mounted) {
          loads++;
          worstJump = Math.max(worstJump, Math.abs(r.moved - r.asked));
          if (loads === 3) await film.shot(page, "scrolling-up-mid-load");
        }
        mounted = r.mounted;
        if (r.asked === 0 && (await chat.getByTestId("chat-user").filter({ hasText: prompt(0) }).count()) > 0) break;
      }
      console.log(`  scrolled to the top: ${loads} loads, ${mounted} items mounted, worst jump ${worstJump.toFixed(1)}px`);
      expect(loads).toBeGreaterThan(5);
      expect(worstJump).toBeLessThanOrEqual(JUMP_SLOP_PX);
      await expect(chat.getByTestId("chat-user").filter({ hasText: prompt(0) })).toBeVisible();
      await film.shot(page, "top-first-prompt");

      // 3. Scrolled up, entries landing below leave the view alone.
      await scrollBy(page, 3000);
      const reading = await topInView(page);
      for (let i = 0; i < 3; i++) appendTurn(transcriptFile, `live while reading ${i}`);
      await expect(chat.getByTestId("chat-user").filter({ hasText: "live while reading 2" })).toHaveCount(1, {
        timeout: 15_000,
      });
      await page.waitForTimeout(500);
      const after = await topInView(page);
      expect(after.text).toBe(reading.text);
      expect(Math.abs(after.top - reading.top)).toBeLessThanOrEqual(JUMP_SLOP_PX);
      await film.shot(page, "reading-while-entries-land");

      // 4. Back at the bottom: the newest items only, and it follows again.
      for (let i = 0; i < 400; i++) {
        const g = await geometry(page);
        if (g.scrollHeight - g.scrollTop - g.clientHeight < 48) break;
        await scrollBy(page, 20_000);
      }
      await expect.poll(async () => (await geometry(page)).mounted).toBeLessThanOrEqual(MAX_MOUNTED);
      appendTurn(transcriptFile, "after coming back");
      const landed = chat.getByTestId("chat-assistant").filter({ hasText: "reply to after coming back" });
      await expect(landed).toBeInViewport({ timeout: 15_000 });
      await film.shot(page, "back-at-bottom-following");
    } finally {
      await client.close();
    }
  });
});
