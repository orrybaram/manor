import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test as base } from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import {
  installRemoteStubs,
  onRemote,
  pollFor,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
} from "./helpers/remote-host";
import { CONNECT_TIMEOUT, STEP, openRemoteProject } from "./helpers/remote-project";

/**
 * Merged stats across servers (#541): the desktop's Stats page counts its
 * own history and every adopted host's, awards badges once on the total, and
 * a reset clears both machines.
 *
 * 1. The desktop starts with 3 prompts today. The box's host server starts
 *    with 7 prompts today, 12 subagents on 2026-09-01 and the Delegator badge
 *    it earned that day, plus its own "Badge unlocked: Fleet" bell record.
 * 2. The desktop opens a project on the box (adopting its host server).
 * 3. The desktop's summary reads 10 prompts today and holds Delegator,
 *    dated by the box, quietly: no unlock toast, no bell entry. The box's own
 *    Fleet record is not in the bell.
 * 4. Reset on the desktop clears the box's stats file too.
 */

const skipReason = remoteSkipReason();

/** Local YYYY-MM-DD, as `StatsStore` keys its days. */
function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DELEGATOR_AT = "2026-09-01T10:00:00.000Z";

/** The desktop's stats file starts with its own 3 prompts today. */
const test = base.extend({
  tempHome: async ({ tempHome }, use) => {
    const dataDir = path.join(tempHome, ".local", "share", "Manor");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "stats.json"),
      JSON.stringify({ version: 1, days: { [localDay()]: { prompts: 3 } }, badges: {} }),
    );
    await use(tempHome);
  },
});

test.skip(skipReason !== null, skipReason ?? "");
test.describe.configure({ mode: "serial" });

const BOX_SERVER_DIR = '"$HOME/.manor/remote/server"';

/** Write `value` as JSON to `file` under the box's host server dir. */
function writeBoxJson(file: string, value: unknown): void {
  const json = JSON.stringify(value).replace(/'/g, `'\\''`);
  onRemote(`mkdir -p ${BOX_SERVER_DIR} && printf '%s' '${json}' > ${BOX_SERVER_DIR}/${file}`);
}

/** The box's stats file, or null when there is none. */
function readBoxStats(): { days: Record<string, Record<string, number>> } | null {
  const out = onRemote(`cat ${BOX_SERVER_DIR}/stats.json 2>/dev/null || true`).stdout.trim();
  return out ? JSON.parse(out) : null;
}

test.beforeAll(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
  // The box's day key is the box's local day.
  const boxToday = onRemote("date +%F").stdout.trim();
  writeBoxJson("stats.json", {
    version: 1,
    days: { [boxToday]: { prompts: 7 }, "2026-09-01": { subagents: 12 } },
    badges: { delegator: DELEGATOR_AT },
  });
  writeBoxJson("notifications.json", {
    notifications: [
      {
        id: "box-fleet",
        kind: "badge-unlocked",
        title: "Badge unlocked: Fleet",
        body: "Shipped 50 workspaces.",
        timestamp: new Date().toISOString(),
        read: false,
        target: { type: "stats", badgeId: "fleet" },
      },
    ],
  });
});

interface Summary {
  allTime: Record<string, number>;
  today: Record<string, number>;
  badges: Record<string, string>;
  quietBadges?: string[];
}

function summary(window: Page): Promise<Summary> {
  return window.evaluate(() => window.electronAPI.stats.getSummary()) as Promise<Summary>;
}

const unlockToast = (window: Page) => window.getByRole("status", { name: /Achievement unlocked/ });

test.describe("merged stats", () => {
  test.setTimeout(CONNECT_TIMEOUT + 6 * STEP);

  test("the desktop counts the box's history with its own, quietly, and a reset clears both", async ({
    window,
    request,
    tempHome,
  }) => {
    const film = new Filmstrip("merged-stats");
    expect((await summary(window)).allTime.prompts).toBe(3);

    // 2. Adopt the box.
    await openRemoteProject(window, request, tempHome);

    // 3. The totals are the sum; the box's badge arrived with its date.
    let last: Summary | null = null;
    const merged = await pollFor(
      "the box's prompts in the desktop's totals",
      async () => {
        last = await summary(window);
        return last.allTime.prompts === 10 ? last : null;
      },
      STEP,
    ).catch((err: unknown) => {
      console.log("desktop summary:", JSON.stringify(last));
      console.log("box stats:", JSON.stringify(readBoxStats()));
      console.log("box dir:", onRemote(`ls -la ${BOX_SERVER_DIR}`, { allowFailure: true }).stdout);
      throw err;
    });
    expect(merged.badges.delegator).toBe(DELEGATOR_AT);
    expect(merged.quietBadges).toContain("delegator");
    expect(merged.allTime.subagents).toBe(12);
    await expect(unlockToast(window)).toHaveCount(0);

    // The Stats page, as the user sees it.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.locator("[cmdk-input]")).toBeFocused();
    await window.keyboard.type("Stats");
    await window.keyboard.press("Enter");
    await expect(window.getByText("10", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await film.shot(window, "stats-merged");
    // The box's badge, on the trophy room's Badges tab.
    await window.getByRole("tab", { name: /badges/i }).click();
    await expect(window.getByText("Delegator").first()).toBeVisible({ timeout: 5_000 });
    await film.shot(window, "badges-merged");
    // Out of the view, then out of the palette.
    await expect(async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator("[cmdk-input]")).toHaveCount(0, { timeout: 500 });
    }).toPass({ timeout: 10_000 });

    // The bell: no badge record, neither the box's nor a new one.
    await window.getByTestId("notifications-bell").click();
    const popover = window.getByTestId("notifications-popover");
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await expect(popover).not.toContainText("Badge unlocked");
    await film.shot(window, "bell-no-badge");
    await window.keyboard.press("Escape");
    await expect(unlockToast(window)).toHaveCount(0);

    // 4. Reset clears the box as well.
    await window.evaluate(() => window.electronAPI.stats.reset());
    await pollFor(
      "the box's stats cleared",
      () => {
        const box = readBoxStats();
        return box === null || Object.keys(box.days).length === 0 ? true : null;
      },
      STEP,
    );
    const after = await summary(window);
    expect(after.allTime.prompts ?? 0).toBe(0);
    expect(after.badges).toEqual({});
  });
});
