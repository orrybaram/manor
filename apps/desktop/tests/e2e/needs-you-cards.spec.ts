import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { type ElectronApplication, type Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";
import { installFakeGh, type FakePr } from "./helpers/fake-gh";
import { useTheme } from "./helpers/theme";

/**
 * The dashboard's Needs you rows, rendered by the real app from PRs a fake
 * `gh` reports: one worktree per blocked/ready state. Checks that every row
 * shows its kind, why it needs you, its one primary action and Snooze, that
 * no action spills out of its row, that Merge opens the PR popover, and
 * writes screenshots of the section at a wide and a narrow window to
 * `tests/e2e/artifacts/needs-you/` for eyeballing the layout.
 */

type Check = { name: string; conclusion: string | null; status?: string; workflowName: string };

const pass = (name: string): Check => ({ name, conclusion: "SUCCESS", workflowName: "CI" });
const fail = (name: string): Check => ({ name, conclusion: "FAILURE", workflowName: "CI" });
const running = (name: string): Check => ({
  name,
  conclusion: null,
  status: "IN_PROGRESS",
  workflowName: "CI",
});

type Case = {
  branch: string;
  number: number;
  title: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  rollup: Check[];
  unresolved?: number;
  conflicting?: boolean;
  /** The row's kind label. */
  kind: string;
  /** The row's context: why it needs you. */
  context: string;
  /** The row's primary action. */
  primary: string;
};

const CASES: Case[] = [
  {
    branch: "checks",
    number: 16623,
    title: "feat(apps/extension): save a guide me viewer's fix for the next viewer [TAN-21677]",
    reviewDecision: "REVIEW_REQUIRED",
    rollup: [
      fail("🧹 Lint, Format, Verify GraphQL schema"),
      fail("🧪 Unit tests (shard 1/4)"),
      fail("🧪 Unit tests (shard 2/4)"),
      ...Array.from({ length: 12 }, (_, i) => pass(`build ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => running(`e2e ${i}`)),
    ],
    kind: "Checks failing",
    context: "✕ 🧹 Lint, Format, Verify GraphQL schema, 🧪 Unit tests (shard 1/4) +1 more",
    primary: "Fix with agent",
  },
  {
    branch: "conflicts",
    number: 86,
    title: "feat: agent risk judgement via report-risk tool",
    reviewDecision: "APPROVED",
    rollup: [pass("unit")],
    conflicting: true,
    kind: "Conflicts",
    context: "Conflicts with the base branch",
    primary: "Fix with agent",
  },
  {
    branch: "threads",
    number: 90,
    title: "feat: Review Routing recompute, stale on push, level only rises",
    reviewDecision: "APPROVED",
    rollup: [pass("unit")],
    unresolved: 5,
    kind: "Unresolved threads",
    context: "reviewer-jane: “Still needs a look.”",
    primary: "Fix with agent",
  },
  {
    branch: "changes",
    number: 94,
    title: "fix: debounce the sidebar resize",
    reviewDecision: "CHANGES_REQUESTED",
    rollup: [pass("unit")],
    kind: "Changes requested",
    context: "A reviewer requested changes",
    primary: "Fix with agent",
  },
  {
    branch: "ready",
    number: 97,
    title: "chore: bump electron",
    reviewDecision: "APPROVED",
    rollup: [pass("unit"), pass("lint")],
    kind: "Ready to merge",
    context: "approved · 2/2 checks",
    primary: "Merge",
  },
];


/** PRs that don't need the user: they fill the PR table but stay out of Needs you. */
type Extra = { branch: string; number: number; title: string; draft?: boolean; rollup: Check[]; reviewDecision: Case["reviewDecision"]; ageMs: number };
const EXTRAS: Extra[] = [
  { branch: "review", number: 101, title: "fix: stop counting a purchase twice", rollup: [pass("unit"), pass("lint")], reviewDecision: "REVIEW_REQUIRED", ageMs: 6 * 86_400_000 },
  { branch: "draft", number: 102, title: "feat: send click IDs with sign-up", draft: true, rollup: [pass("unit")], reviewDecision: null, ageMs: 4 * 86_400_000 },
  { branch: "running", number: 103, title: "feat: forward the ad click ID", rollup: [pass("unit"), running("e2e 1"), running("e2e 2")], reviewDecision: "REVIEW_REQUIRED", ageMs: 40 * 60_000 },
];

function fakeExtra(e: Extra): FakePr {
  return {
    number: e.number,
    state: "OPEN",
    title: e.title,
    url: `https://github.com/acme/app/pull/${e.number}`,
    isDraft: e.draft ?? false,
    additions: 120,
    deletions: 30,
    reviewDecision: e.reviewDecision,
    updatedAt: new Date(Date.now() - e.ageMs).toISOString(),
    autoMergeRequest: null,
    statusCheckRollup: e.rollup,
    mergeable: "MERGEABLE",
  };
}

function fakePr(c: Case): FakePr {
  return {
    number: c.number,
    state: "OPEN",
    title: c.title,
    url: `https://github.com/acme/app/pull/${c.number}`,
    isDraft: false,
    additions: 10,
    deletions: 2,
    reviewDecision: c.reviewDecision,
    updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    autoMergeRequest: null,
    statusCheckRollup: c.rollup,
    mergeable: c.conflicting ? "CONFLICTING" : "MERGEABLE",
  };
}

function conversation(c: Case): unknown {
  const threads = Array.from({ length: c.unresolved ?? 0 }, (_, i) => ({
    isResolved: false,
    path: `src/thing-${i}.ts`,
    comments: {
      nodes: [
        {
          author: { login: "reviewer-jane" },
          body: "Still needs a look.",
          url: `https://github.com/acme/app/pull/${c.number}#discussion_r${i}`,
          createdAt: "2026-09-08T09:30:00Z",
        },
      ],
    },
  }));
  return {
    isInMergeQueue: false,
    reviewThreads: { nodes: threads },
    comments: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
  };
}

const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    const projectPath = path.join(tempHome, "test-project");
    const originPath = path.join(tempHome, "origin.git");
    execSync(`git init --bare "${originPath}"`);
    execSync(`git remote add origin "${originPath}"`, { cwd: projectPath });
    execSync("git push -u origin main", { cwd: projectPath });

    const worktreeRoot = path.join(tempHome, "worktrees");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const workspaces = [...CASES, ...EXTRAS].map((c) => {
      const wtPath = path.join(worktreeRoot, c.branch);
      execSync(`git worktree add "${wtPath}" -b "${c.branch}"`, {
        cwd: projectPath,
        stdio: "ignore",
      });
      return { path: wtPath, branch: c.branch, isMain: false, name: null, linkedIssues: [] };
    });

    const seed = {
      projects: [
        {
          id: "proj-needs-you",
          name: "birb-bot",
          path: projectPath,
          defaultBranch: "main",
          workspaces: [
            { path: projectPath, branch: "main", isMain: true, name: null, linkedIssues: [] },
            ...workspaces,
          ],
          workspaceFolders: [],
          selectedWorkspaceIndex: 0,
          defaultRunCommand: null,
          worktreePath: worktreeRoot,
          worktreeStartScript: null,
          worktreeTeardownScript: null,
          linearAssociations: [],
          color: "yellow",
          agentCommand: "echo AGENT_PROMPT",
          commands: [],
          themeName: null,
          setupComplete: true,
        },
      ],
      selectedProjectIndex: 0,
    };
    for (const dir of [
      path.join(tempHome, "Library", "Application Support", "Manor"),
      path.join(tempHome, ".local", "share", "Manor"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(seed, null, 2));
    }

    const binDir = installFakeGh(tempHome, {
      prs: Object.fromEntries([
        ...CASES.map((c) => [c.branch, fakePr(c)] as const),
        ...EXTRAS.map((e) => [e.branch, fakeExtra(e)] as const),
      ]),
      conversations: Object.fromEntries([
        ...CASES.map((c) => [c.number, conversation(c)] as const),
        ...EXTRAS.map((e) => [e.number, conversation({ unresolved: 0, number: e.number } as Case)] as const),
      ]),
    });
    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

    const app = await launchApp(tempHome);
    process.env.PATH = originalPath;
    await use(app);
    await killApp(app);
  },
});

const OUT = path.join(__dirname, "artifacts", "needs-you");

test("Needs you rows: every blocked/ready PR says why, actions inside the row", async ({
  app,
  window,
}) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });

  await window.getByTestId("home-row").click();
  const section = window.getByRole("region", { name: "Needs you" });
  const rows = section.getByRole("listitem");
  await expect(rows).toHaveCount(CASES.length, { timeout: 60_000 });

  for (const c of CASES) {
    const row = rows.filter({ hasText: `#${c.number}` });
    await expect(row, c.branch).toContainText(c.kind);
    await expect(row, c.branch).toContainText(c.context);
    await expect(row.getByRole("button", { name: c.primary, exact: true }), c.branch).toBeVisible();
    await expect(row.getByTitle(/^Open workspace/), c.branch).toBeVisible();
    await expect(row.getByRole("link", { name: `PR #${c.number}`, exact: true }), c.branch).toHaveAttribute(
      "href",
      `https://github.com/acme/app/pull/${c.number}`,
    );
    await expect(row.getByRole("button", { name: "Snooze for 1 hour" }), c.branch).toBeVisible();
  }

  // Failing checks link to the first failing run.
  await expect(
    rows.filter({ hasText: "#16623" }).getByRole("link", { name: /^View check/ }),
  ).toBeVisible();

  // Merge opens the PR popover, merge controls and all, on the button.
  await rows.filter({ hasText: "#97" }).getByRole("button", { name: "Merge", exact: true }).click();
  const popover = window.locator("[data-radix-popper-content-wrapper]");
  await expect(popover.getByTestId("pr-state")).toHaveText("Open");
  await popover.screenshot({ path: path.join(OUT, "needs-you-merge-popover.png"), animations: "disabled" });
  await window.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  for (const width of [1400, 1000, 760]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]?.setSize(w, 1000);
    }, width);
    await window.waitForTimeout(400);

    // Every action sits inside its row, and every action is one height.
    const layout = await rows.evaluateAll((els) =>
      els.map((row) => {
        const box = row.getBoundingClientRect();
        const actions = Array.from(row.querySelectorAll("button"))
          .filter((el) => el.closest("div") !== null && !el.title.startsWith("Open workspace"))
          .map((el) => el.getBoundingClientRect());
        return {
          label: row.getAttribute("aria-label"),
          overflow: actions.some((a) => a.right > box.right - 1 || a.left < box.left),
          heights: [...new Set(actions.map((a) => Math.round(a.height)))],
        };
      }),
    );
    for (const l of layout) {
      expect(l.overflow, `${width}px ${l.label} overflow`).toBe(false);
      expect(l.heights, `${width}px ${l.label} action heights`).toHaveLength(1);
    }

    await section.screenshot({ path: path.join(OUT, `needs-you-${width}.png`), animations: "disabled" });
  }
});

const SHOTS = path.join(__dirname, "artifacts", "dashboard");

test("Dashboard: PR table, side rail, nav count, both themes and widths", async ({ app, window }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const size = async (w: number, h = 1100) => {
    await app.evaluate(({ BrowserWindow }, [ww, hh]) => {
      BrowserWindow.getAllWindows()[0]?.setSize(ww!, hh!);
    }, [w, h]);
    await window.waitForTimeout(500);
  };

  await window.getByTestId("home-row").click();
  const needs = window.getByRole("region", { name: "Needs you" });
  await expect(needs.getByRole("listitem")).toHaveCount(CASES.length, { timeout: 60_000 });

  // Every open PR is a table row, drafts last.
  const table = window.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(CASES.length + EXTRAS.length, { timeout: 30_000 });
  await expect(table.locator("tbody tr").last()).toContainText("#102");

  // The nav row carries the count.
  await expect(window.getByTestId("home-row")).toContainText(String(CASES.length));

  // The old sections are gone; the rail's are there.
  await expect(window.getByText("Waiting on you", { exact: true })).toHaveCount(0);
  const rail = window.getByRole("complementary", { name: "Activity and stats" });
  for (const name of ["Agents working", "Open PRs", "Merged this week", "Up next"]) {
    await expect(rail.getByRole("region", { name }), name).toBeVisible();
  }

  for (const theme of ["Catppuccin Mocha", "Catppuccin Latte"] as const) {
    await useTheme(window, theme);
    const tag = theme === "Catppuccin Mocha" ? "dark" : "light";
    for (const width of [1900, 1100]) {
      await size(width);
      // The page never scrolls sideways.
      const sideways = await window.getByTestId("home-view").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(sideways, `${tag} ${width} sideways scroll`).toBe(false);
      await window.screenshot({ path: path.join(SHOTS, `dashboard-${width}-${tag}.png`), animations: "disabled" });
      await window.getByTestId("home-view").screenshot({ path: path.join(SHOTS, `dashboard-${width}-${tag}-full.png`), animations: "disabled" });
    }
    await size(1900);
    await table.screenshot({ path: path.join(SHOTS, `pr-table-${tag}.png`), animations: "disabled" });
    await rail.screenshot({ path: path.join(SHOTS, `rail-${tag}.png`), animations: "disabled" });
    await window.getByTestId("home-row").screenshot({ path: path.join(SHOTS, `nav-row-${tag}.png`), animations: "disabled" });
  }

  // Rail beside the main column when wide, under it when narrow.
  await size(1900);
  const wideRail = (await rail.boundingBox())!;
  const wideTable = (await table.boundingBox())!;
  expect(wideRail.x).toBeGreaterThan(wideTable.x + wideTable.width - 1);
  await size(1100);
  const narrowRail = (await rail.boundingBox())!;
  const narrowTable = (await table.boundingBox())!;
  expect(narrowRail.y).toBeGreaterThan(narrowTable.y);

  // Hovering a PR row shows its PR card.
  await size(1900);
  await table.locator("tbody tr").filter({ hasText: "#101" }).hover();
  const popover = window.locator("[data-radix-popper-content-wrapper]");
  await expect(popover.getByTestId("pr-state")).toBeVisible({ timeout: 5_000 });
  await window.screenshot({ path: path.join(SHOTS, "pr-row-hover.png"), animations: "disabled" });
  await window.mouse.move(5, 5);
  await expect(popover).toHaveCount(0, { timeout: 5_000 });

  // Phone width: one column, nothing scrolls sideways.
  await size(420, 900);
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.layout)).toBe("phone");
  const phoneSideways = await window.getByTestId("home-view").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(phoneSideways, "phone sideways scroll").toBe(false);
  await window.screenshot({ path: path.join(SHOTS, "dashboard-phone-light.png"), animations: "disabled" });
  await window.getByTestId("home-view").screenshot({ path: path.join(SHOTS, "dashboard-phone-light-full.png"), animations: "disabled" });
  await size(1900);
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.layout)).toBe("desk");

  // The collapsed sidebar's Dashboard icon carries the count too.
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Collapse Sidebar");
  await window.locator("[cmdk-item]", { hasText: "Collapse Sidebar" }).first().click();
  const railHome = window.getByTestId("rail-home");
  await expect(railHome).toHaveAttribute("aria-label", new RegExp(`${CASES.length} need you`));
  await window.getByTestId("sidebar-rail").screenshot({ path: path.join(SHOTS, "sidebar-rail-badge.png"), animations: "disabled" });
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Collapse Sidebar");
  await window.locator("[cmdk-item]", { hasText: "Collapse Sidebar" }).first().click();
  await expect(window.getByTestId("home-row")).toBeVisible();

  // Snoozing everything empties Needs you and clears the count.
  const rows = needs.getByRole("listitem");
  await expect(rows).toHaveCount(CASES.length);
  while ((await rows.count()) > 0) {
    await rows.first().getByRole("button", { name: "Snooze for 1 hour" }).click();
    await window.waitForTimeout(250);
  }
  await expect(needs).toContainText("Nothing needs you right now.");
  await expect(window.getByTestId("home-row")).not.toContainText(/\d/);
  await window.screenshot({ path: path.join(SHOTS, "needs-you-empty.png"), animations: "disabled" });
});
