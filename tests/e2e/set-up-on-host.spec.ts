import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  APP_TARGET,
  SEED_REPO_URL,
  onRemote,
  pollFor,
  remoteSkipReason,
  seedRemoteRepo,
} from "./helpers/remote-host";

/**
 * Where a project lives, end to end against a real sshd (ADR-214):
 *
 * 1. "Set up on ▸ <host>" clones a local project onto the box and joins it.
 * 2. The success toast's "Remove from This machine" finishes a move.
 * 3. "Set up on ▸ Choose location…" adopts an existing local checkout.
 * 4. Project Settings → Hosts → "Keep separate…" splits it.
 * 5. A new same-origin project joins on its own; Undo splits it again and
 *    gives it back its own name.
 *
 * Skipped unless MANOR_E2E_SSH=1 (see remote-host.spec.ts for the harness).
 * Set MANOR_SHOTS to a directory to save a screenshot per step.
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");
test.describe.configure({ mode: "serial" });

const STEP = 60_000;
let shot = 0;

async function snap(window: Page, name: string): Promise<void> {
  const dir = process.env.MANOR_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  shot += 1;
  await window.screenshot({ path: path.join(dir, `${String(shot).padStart(2, "0")}-${name}.png`) });
}

interface ProjectRow {
  id: string;
  name: string;
  hostId: string;
  path: string;
}

async function projects(window: Page): Promise<ProjectRow[]> {
  return (await window.evaluate(() => window.electronAPI.projects.getAll())) as ProjectRow[];
}

async function openSetUpOn(window: Page, header: ReturnType<Page["getByTestId"]>): Promise<void> {
  await header.click({ button: "right" });
  await window.getByRole("menuitem", { name: /Set up on/ }).hover();
}

test.beforeAll(() => {
  onRemote(
    '[ -x "$HOME/.manor/bin/manor-host" ] && "$HOME/.manor/bin/manor-host" restart >/dev/null 2>&1; ' +
      'rm -rf "$HOME/.manor/remote" "$HOME/code"; true',
    { timeoutMs: STEP },
  );
  seedRemoteRepo();
});

test("set up on, remove from, adopt, keep separate, auto-join", async ({ window, tempHome }) => {
  test.setTimeout(10 * 60_000);

  // Local checkouts whose stored origin is the seed URL. The box rewrites
  // that URL to its own bare repo; here they are cloned from a local one.
  const bare = path.join(tempHome, "seed.git");
  const work = path.join(tempHome, "seed-work");
  const local = path.join(tempHome, "code", "seed");
  const clone = (dir: string) =>
    `git clone -q ${bare} ${dir} && git -C ${dir} remote set-url origin ${SEED_REPO_URL}`;
  execSync(
    [
      `git init -q --bare -b main ${bare}`,
      `git init -q -b main ${work}`,
      `git -C ${work} -c user.email=e@x -c user.name=e commit -q --allow-empty -m init`,
      `git -C ${work} push -q ${bare} main`,
      `mkdir -p ${path.dirname(local)}`,
      clone(local),
    ].join(" && "),
  );

  // Registering the host has no UI of its own worth testing here.
  const { hostId } = await window.evaluate((t) => window.electronAPI.hosts.add(t), APP_TARGET);
  await pollFor(
    "host connected",
    async () => {
      const hosts = (await window.evaluate(() => window.electronAPI.hosts.list())) as Array<{
        hostId: string;
        status: string;
        error?: string;
      }>;
      const h = hosts.find((x) => x.hostId === hostId);
      if (h?.status === "error") throw new Error(`host failed: ${h.error}`);
      return h?.status === "connected" ? h : null;
    },
    5 * 60_000,
    500,
  );
  await window.evaluate((p) => window.electronAPI.projects.add("seed", p), local);
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  const header = window.getByTestId("project-header").filter({ hasText: "seed" });
  await expect(header).toBeVisible({ timeout: 20_000 });

  // ── 1. Set up on ▸ manor-e2e: one click, no form ──
  await openSetUpOn(window, header);
  await expect(window.getByRole("menuitem", { name: APP_TARGET })).toBeVisible();
  await snap(window, "set-up-submenu");
  await window.getByRole("menuitem", { name: APP_TARGET }).click();
  await expect(window.getByText(`seed is set up on ${APP_TARGET}`)).toBeVisible({ timeout: 2 * STEP });
  onRemote("test -d $HOME/code/seed/.git");
  await expect(window.getByTestId("group-section-header")).toHaveText(["This machine", APP_TARGET]);
  await snap(window, "set-up");

  // ── 2. The toast's "Remove from This machine" finishes the move ──
  await window.getByRole("button", { name: "Remove from This machine" }).click();
  const confirm = window.getByRole("dialog");
  await expect(confirm).toContainText("Remove seed from This machine?");
  await expect(confirm).toContainText("Files there aren't deleted.");
  await snap(window, "remove-confirm");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(window.getByTestId("project-group")).toHaveCount(0, { timeout: 20_000 });
  expect((await projects(window)).map((p) => p.hostId)).toEqual([hostId]);
  // Files on this machine are kept.
  expect(fs.existsSync(path.join(local, ".git"))).toBe(true);

  // ── 3. Set up on ▸ Choose location…: adopt the existing local checkout ──
  await openSetUpOn(window, window.getByTestId("project-header").filter({ hasText: "seed" }));
  await window.getByRole("menuitem", { name: /Choose location/ }).click();
  const dialog = window.getByRole("dialog");
  await expect(dialog).toContainText("Set up seed on this machine");
  await expect(dialog.getByRole("button", { name: /Use an existing folder/ })).toBeVisible();
  // The stored origin, not the box's `insteadOf` rewrite of it.
  await expect(dialog.locator("input").first()).toHaveValue(SEED_REPO_URL);
  // The native folder picker can't be driven; type the folder instead.
  await dialog.locator("input").last().fill(local);
  await snap(window, "choose-location");
  await dialog.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(window.getByTestId("project-group")).toBeVisible({ timeout: 2 * STEP });
  // Adopted, not cloned: still one checkout there, and on this machine.
  expect((await projects(window)).map((p) => p.hostId).sort()).toEqual([hostId, "local"].sort());

  // ── 4. Project Settings → Hosts → Keep separate… ──
  await window.getByTestId("project-group-header").click({ button: "right" });
  await window.getByRole("menuitem", { name: "Project Settings" }).click();
  await expect(window.getByText("Where this project is set up.", { exact: false })).toBeVisible();
  await window.getByRole("button", { name: /Keep separate/ }).click();
  await snap(window, "keep-separate");
  await window.getByRole("dialog").last().getByRole("button", { name: "Keep separate" }).click();
  await expect(window.getByTestId("project-group")).toHaveCount(0, { timeout: 20_000 });
  await window.keyboard.press("Escape");

  // ── 5. A new same-origin project joins on its own; Undo splits it ──
  for (const p of (await projects(window)).filter((x) => x.hostId === "local")) {
    await window.evaluate((id) => window.electronAPI.projects.remove(id), p.id);
  }
  const local2 = path.join(tempHome, "code", "seed2");
  execSync(clone(local2));
  await window.evaluate((p) => window.electronAPI.projects.add("seed2", p), local2);
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.getByText(`Joined seed2 on This machine with seed on ${APP_TARGET}`)).toBeVisible({
    timeout: 20_000,
  });
  await expect(window.getByTestId("project-group")).toBeVisible();
  await snap(window, "auto-join");
  await window.getByRole("button", { name: "Undo" }).click();
  await expect(window.getByTestId("project-group")).toHaveCount(0, { timeout: 20_000 });
  expect((await projects(window)).map((p) => p.name).sort()).toEqual(["seed", "seed2"]);
  await snap(window, "after-undo");
});
