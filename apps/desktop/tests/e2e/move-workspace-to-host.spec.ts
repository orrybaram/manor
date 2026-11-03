import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * The Move to Host dialog (design R1), with the move's bridge calls stubbed
 * in the page: the menu, the confirm dialog and its problems, the lane
 * stepping through a plan, a failure with its details, success closing onto
 * the workspace, and the palette's host picker. The move itself is covered
 * by the unit tests over `workspace-host-move.ts`; this is its UI.
 *
 * `MANOR_E2E_SHOTS=<dir>` saves each state as a PNG there.
 */

const SHOTS = process.env.MANOR_E2E_SHOTS;
const HOST_ID = "e2e-devbox";
const WS = "search-filters";

type Theme = "dark" | "light";

const STEPS = [
  { id: "push" },
  { id: "setUp" },
  { id: "create" },
  { id: "setupScript" },
  { id: "restore" },
  { id: "agents", detail: "claude" },
  { id: "removeSource" },
];

/**
 * Wrap `window.electronAPI` as it is installed: a fake remote host in
 * `hosts.list`, and the move's three calls answered from `window.__move`.
 */
function installStub(): void {
  type Listener = (event: unknown) => void;
  const state = {
    preflight: {} as Record<string, unknown>,
    listeners: new Set<Listener>(),
    moveId: null as string | null,
    resolve: null as ((result: unknown) => void) | null,
    requests: [] as unknown[],
    /** While set, preflights wait for `releasePreflight`. */
    holdPreflight: false,
    held: [] as Array<() => void>,
    releasePreflight() {
      state.holdPreflight = false;
      for (const go of state.held.splice(0)) go();
    },
    emit(event: Record<string, unknown>) {
      for (const l of state.listeners) l({ ...event, moveId: state.moveId });
    },
    finish(result: Record<string, unknown>) {
      state.resolve?.({ ...result, moveId: state.moveId });
      state.resolve = null;
    },
  };
  (window as unknown as { __move: typeof state }).__move = state;
  const wrap = (api: Record<string, Record<string, unknown>>) => {
    const projects = new Proxy(api.projects, {
      get(target, key, receiver) {
        if (key === "moveWorkspaceToHostPreflight") {
          return async () => {
            if (state.holdPreflight) await new Promise<void>((go) => state.held.push(go));
            return structuredClone(state.preflight);
          };
        }
        if (key === "onMoveWorkspaceToHostProgress") {
          return (cb: Listener) => {
            state.listeners.add(cb);
            return () => state.listeners.delete(cb);
          };
        }
        if (key === "moveWorkspaceToHost") {
          return (req: { moveId: string }) => {
            state.moveId = req.moveId;
            state.requests.push(req);
            return new Promise((resolve) => {
              state.resolve = resolve;
            });
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const hosts = new Proxy(api.hosts, {
      get(target, key, receiver) {
        if (key === "list") {
          return async () => {
            const real = (await (target.list as () => Promise<unknown[]>)()) ?? [];
            return [
              ...real,
              { hostId: "e2e-devbox", spec: { kind: "ssh", target: "devbox" }, label: "devbox", status: "disconnected" },
            ];
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    return new Proxy(api, {
      get(target, key, receiver) {
        if (key === "projects") return projects;
        if (key === "hosts") return hosts;
        return Reflect.get(target, key, receiver);
      },
    });
  };
  let current: unknown;
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    get: () => current,
    set: (api) => {
      current = api ? wrap(api) : api;
    },
  });
}

function preflight(extra: Record<string, unknown> = {}) {
  return {
    sourceHostId: "local",
    branch: WS,
    name: WS,
    isMain: false,
    hasOrigin: true,
    dirtyFiles: [],
    needsPush: true,
    targetProjectId: null,
    targetHasProject: false,
    refusals: [],
    ...extra,
  };
}

async function setPreflight(window: Page, value: Record<string, unknown>): Promise<void> {
  await window.evaluate((v) => {
    (window as unknown as { __move: { preflight: unknown } }).__move.preflight = v;
  }, value);
}

async function emit(window: Page, event: Record<string, unknown>): Promise<void> {
  await window.evaluate((e) => {
    (window as unknown as { __move: { emit(e: unknown): void } }).__move.emit(e);
  }, event);
}

async function finish(window: Page, result: Record<string, unknown>): Promise<void> {
  await window.evaluate((r) => {
    (window as unknown as { __move: { finish(r: unknown): void } }).__move.finish(r);
  }, result);
}

async function useTheme(window: Page, theme: Theme): Promise<void> {
  if (theme === "dark") {
    await window.evaluate(() => {
      document.documentElement.removeAttribute("style");
    });
    await window.evaluate(() => window.electronAPI.theme.setSelected("__default__")).catch(() => {});
    await window.waitForTimeout(400);
    return;
  }
  await window.evaluate(() => {
    const latte: Record<string, string> = {
      "--bg": "#eff1f5",
      "--fg": "#4c4f69",
      "--dim": "#e6e9ef",
      "--surface": "#ccd0da",
      "--hover": "#dce0e8",
      "--border": "#bcc0cc",
      "--control-border": "#4c4f6940",
      "--text-primary": "#4c4f69b3",
      "--text-selected": "#4c4f69",
      "--text-dim": "#4c4f6980",
      "--accent": "#1e66f5",
      "--danger": "#d20f39",
      "--green": "#40a02b",
      "--red": "#d20f39",
      "--yellow": "#df8e1d",
    };
    for (const [k, v] of Object.entries(latte)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = "light";
  });
  await window.waitForTimeout(300);
}

async function shot(window: Page, name: string, settleMs = 650): Promise<void> {
  if (!SHOTS) return;
  const target = window.getByTestId("move-to-host-dialog");
  await window.waitForTimeout(settleMs);
  // The dialog and the window around it, so the scrim and sidebar show.
  const box = await target.boundingBox();
  if (!box) return;
  const pad = 60;
  await window.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
}

const dialog = (window: Page) => window.getByTestId("move-to-host-dialog");
const mainRow = (window: Page) => window.locator('[data-testid="workspace-item"]').first();
const row = (window: Page) =>
  window.locator('[data-testid="workspace-item"]', { hasText: WS }).first();

async function openFromMenu(window: Page, menuShot?: string): Promise<void> {
  await row(window).click({ button: "right" });
  await window.getByTestId("workspace-move-to-host").hover();
  const item = window.getByTestId(`workspace-move-to-host-${HOST_ID}`);
  await expect(item).toBeVisible();
  if (menuShot && SHOTS) {
    await window.waitForTimeout(300);
    await window.screenshot({ path: path.join(SHOTS, `${menuShot}.png`) });
  }
  await item.click();
  await expect(dialog(window)).toBeVisible();
}

test("Move to Host: menu, confirm, lane, failure, success, palette", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(240_000);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  await window.addInitScript(installStub);
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await bootWorkspaceWithTerminal(app, window, tempHome, WS);
  await expect(row(window)).toBeVisible({ timeout: 30_000 });
  const wsPath = await row(window).getAttribute("data-workspace-path");

  // The main workspace has no Move to Host.
  await mainRow(window).click({ button: "right" });
  await expect(window.getByRole("menu").first()).toBeVisible();
  await expect(window.getByTestId("workspace-move-to-host")).toHaveCount(0);
  await window.keyboard.press("Escape");

  for (const theme of ["dark", "light"] as const) {
    await useTheme(window, theme);

    // Confirm: one sentence, Remove ticked, Move once the preflight is in.
    await setPreflight(window, preflight());
    await openFromMenu(window, `menu-${theme}`);
    await expect(dialog(window)).toContainText(`Move “${WS}” to devbox?`);
    await expect(dialog(window)).toContainText(
      "Your tabs come back on devbox, and agents pick up where they left off.",
    );
    await expect(window.getByTestId("move-to-host-remove-source")).toHaveAttribute("data-state", "checked");
    await expect(window.getByTestId("move-to-host-move")).toBeEnabled();
    await expect(window.getByTestId("move-to-host-reuse")).toHaveCount(0);
    await shot(window, `confirm-${theme}`);
    await window.keyboard.press("Escape");
    await expect(dialog(window)).toHaveCount(0);

    // Dirty: the files, and no Move.
    await setPreflight(
      window,
      preflight({
        dirtyFiles: [],
        refusals: [
          {
            code: "dirty",
            files: [
              { code: " M", path: "src/search/Filters.tsx" },
              { code: " M", path: "src/search/query.ts" },
              { code: "??", path: "src/search/chips.css" },
            ],
          },
        ],
      }),
    );
    await openFromMenu(window);
    await expect(window.getByTestId("move-to-host-dirty")).toContainText(
      "Commit or discard 3 changed files first.",
    );
    await expect(window.getByTestId("move-to-host-move")).toBeDisabled();
    await shot(window, `dirty-${theme}`);
    await window.keyboard.press("Escape");

    // From the main workspace, so success visibly switches.
    await mainRow(window).click();
    await expect(mainRow(window)).toHaveAttribute("aria-current", "true");

    // The target has the branch: a warning, Move still on.
    await setPreflight(
      window,
      preflight({
        targetHasProject: true,
        existingTargetWorktree: { path: "/srv/manor/search-filters", dirty: false, canFastForward: true },
      }),
    );
    await openFromMenu(window);
    await expect(window.getByTestId("move-to-host-reuse")).toContainText(
      "devbox already has this branch checked out. The move will use it.",
    );
    await shot(window, `reuse-${theme}`);

    // Moving: the plan, then steps; the dialog can't be dismissed.
    await window.getByTestId("move-to-host-move").click();
    await expect(window.getByTestId("move-to-host-moving")).toBeVisible();
    await emit(window, { type: "plan", steps: STEPS });
    for (let i = 0; i < 3; i++) {
      await emit(window, { type: "step", index: i, step: STEPS[i].id, status: "running" });
      if (i < 2) await emit(window, { type: "step", index: i, step: STEPS[i].id, status: "done" });
    }
    await expect(window.getByTestId("move-to-host-step")).toHaveText("Creating workspace");
    await expect(window.getByTestId("move-to-host-count")).toHaveText("3 of 7");
    await expect(window.getByTestId("move-to-host-target")).toHaveAttribute("data-lit", "true");
    await window.keyboard.press("Escape");
    await expect(dialog(window)).toBeVisible();
    await shot(window, `moving-${theme}`);

    // Failed: the step, Show details, Retry.
    await emit(window, { type: "step", index: 2, step: "create", status: "failed", error: "boom" });
    await finish(window, {
      ok: false,
      step: "create",
      error: "git worktree add failed: fatal: 'search-filters' is already checked out at '/srv/manor/search-filters'",
    });
    await expect(window.getByTestId("move-to-host-failed")).toHaveText(
      "Creating workspace on devbox failed. Nothing changed on this machine.",
    );
    await expect(dialog(window)).toContainText(`Couldn’t move “${WS}”`);
    await shot(window, `failed-${theme}`);
    await window.getByTestId("move-to-host-show-details").click();
    await expect(window.getByTestId("move-to-host-error")).toContainText("already checked out");
    await shot(window, `failed-details-${theme}`);

    // Retry: the failed view holds, pending and undismissable, while the
    // preflight runs again; then straight on to the move, which succeeds.
    await setPreflight(window, preflight());
    await window.evaluate(() => {
      (window as unknown as { __move: { holdPreflight: boolean } }).__move.holdPreflight = true;
    });
    await window.getByTestId("move-to-host-retry").click();
    await expect(window.getByTestId("move-to-host-retry")).toHaveText("Retrying…");
    await expect(window.getByTestId("move-to-host-retry")).toBeDisabled();
    await window.keyboard.press("Escape");
    await expect(dialog(window)).toHaveAttribute("data-phase", "failed");
    await window.evaluate(() => {
      (window as unknown as { __move: { releasePreflight(): void } }).__move.releasePreflight();
    });
    await expect(window.getByTestId("move-to-host-moving")).toBeVisible();
    await emit(window, { type: "plan", steps: STEPS });
    for (let i = 0; i < STEPS.length; i++) {
      await emit(window, { type: "step", index: i, step: STEPS[i].id, status: "running" });
      if (i === 6) {
        await expect(window.getByTestId("move-to-host-source")).toHaveAttribute("data-dim", "true");
        await expect(window.getByTestId("move-to-host-step")).toHaveText("Removing from this machine");
        if (theme === "dark") await shot(window, "removing-dark");
      }
      await emit(window, { type: "step", index: i, step: STEPS[i].id, status: "done" });
    }
    const projectId = await window.evaluate(async (p) => {
      const all = (await window.electronAPI.projects.getAll()) as Array<{
        id: string;
        workspaces: Array<{ path: string }>;
      }>;
      return all.find((x) => x.workspaces.some((w) => w.path === p))?.id ?? null;
    }, wsPath);
    // The "target" is the workspace itself, so the switch has a row to open.
    await finish(window, {
      ok: true,
      targetProjectId: projectId,
      targetPath: wsPath,
      targetWorkspaceKey: wsPath,
      reused: false,
      sourceRemoved: true,
    });
    await expect(window.getByTestId("move-to-host-step")).toHaveText("Moved to devbox");
    await expect(window.getByTestId("move-to-host-target")).toHaveAttribute("data-ok", "true");
    // Before the dialog closes, ~700ms after success.
    if (theme === "dark") await shot(window, "moved-dark", 350);
    await expect(dialog(window)).toHaveCount(0, { timeout: 5_000 });
    await expect(
      window.locator(`[data-testid="workspace-item"][data-workspace-path="${wsPath}"]`),
    ).toHaveAttribute("aria-current", "true");
  }

  // A Retry the preflight now refuses goes to the confirm view, not the move.
  await setPreflight(window, preflight());
  await openFromMenu(window);
  await window.getByTestId("move-to-host-move").click();
  await emit(window, { type: "plan", steps: STEPS });
  await emit(window, { type: "step", index: 0, step: "push", status: "running" });
  await finish(window, { ok: false, step: "push", error: "rejected" });
  await expect(window.getByTestId("move-to-host-failed")).toHaveText(
    "Pushing branch failed. Nothing changed on this machine.",
  );
  await setPreflight(window, preflight({ refusals: [{ code: "no-origin" }] }));
  await window.getByTestId("move-to-host-retry").click();
  await expect(window.getByTestId("move-to-host-confirm")).toBeVisible();
  await expect(window.getByTestId("move-to-host-refusal")).toBeVisible();
  await expect(window.getByTestId("move-to-host-move")).toBeDisabled();
  const before = await window.evaluate(
    () => (window as unknown as { __move: { requests: unknown[] } }).__move.requests.length,
  );
  await window.keyboard.press("Escape");
  await expect(dialog(window)).toHaveCount(0);
  // The refused Retry started no move.
  expect(
    await window.evaluate(
      () => (window as unknown as { __move: { requests: unknown[] } }).__move.requests.length,
    ),
  ).toBe(before);

  // A failed removal: the workspace is on the target, and closing opens it.
  for (const theme of ["dark", "light"] as const) {
    await useTheme(window, theme);
    await setPreflight(window, preflight());
    await openFromMenu(window);
    await window.getByTestId("move-to-host-move").click();
    await emit(window, { type: "plan", steps: STEPS });
    await emit(window, { type: "step", index: 6, step: "removeSource", status: "running" });
    await finish(window, { ok: false, step: "removeSource", error: "teardown script exited 1" });
    await expect(window.getByTestId("move-to-host-failed")).toHaveText(
      "The workspace is ready on devbox, but removing it from this machine failed.",
    );
    await expect(window.getByTestId("move-to-host-close")).toHaveText("Open on devbox");
    await shot(window, `failed-remove-${theme}`);
    await window.getByTestId("move-to-host-close").click();
    await expect(dialog(window)).toHaveCount(0);
  }
  await useTheme(window, "dark");

  // The request carried Remove's answer.
  const requests = await window.evaluate(
    () => (window as unknown as { __move: { requests: Array<{ keepSource: boolean }> } }).__move.requests,
  );
  expect(requests.every((r) => r.keepSource === false)).toBe(true);

  // Reduced motion: the lane jumps instead of sliding.
  await useTheme(window, "dark");
  await window.emulateMedia({ reducedMotion: "reduce" });
  await setPreflight(window, preflight());
  await openFromMenu(window);
  await window.getByTestId("move-to-host-move").click();
  await emit(window, { type: "plan", steps: STEPS });
  await emit(window, { type: "step", index: 3, step: "setupScript", status: "running" });
  const transition = await window
    .locator('[data-testid="move-to-host-moving"] [style*="width"]')
    .first()
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(transition).toBe("0s");
  await shot(window, "moving-reduced-motion-dark");
  await finish(window, { ok: false, step: "setupScript", error: "exit 1" });
  await window.getByRole("button", { name: "Close" }).click();
  await window.emulateMedia({ reducedMotion: "no-preference" });

  // The palette opens the dialog on a host picker.
  await row(window).click();
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Move Workspace to Host");
  await window.locator("[cmdk-item]", { hasText: "Move Workspace to Host" }).first().click();
  await expect(window.getByTestId("move-to-host-picker")).toBeVisible();
  await shot(window, "palette-picker-dark");
  await window.getByTestId(`move-to-host-pick-${HOST_ID}`).click();
  await expect(window.getByTestId("move-to-host-confirm")).toBeVisible();
  await expect(dialog(window)).toContainText(`Move “${WS}” to devbox?`);
});
