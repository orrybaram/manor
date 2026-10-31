import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { killApp, launchApp, openTerminalTab, test as base, expect } from "./fixtures";
import { editFakePr, fakeGhCalls, installFakeGh, type FakeCheck, type FakePr } from "./helpers/fake-gh";
import { Filmstrip } from "./helpers/filmstrip";
import { activePaneId, awaitShellReady, runInTerminal, scrollback } from "./helpers/terminal";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { useTheme } from "./helpers/theme";

/**
 * The PR card's footer, end to end against a fake `gh`: a failing check is
 * handed to an agent, goes green, and the PR merges and takes its workspace
 * with it; unresolved threads are handed over with file and line; a pending
 * PR arms auto-merge; a merge-queue PR is queued and its workspace goes once
 * the queue lands it. The agent is `echo AGENT_PROMPT`, so the brief it was
 * started with is in its pane's scrollback.
 */

const REPO = "https://github.com/acme/app";
const FAILING_LOG = [
  "ci\ttypecheck\t2026-10-30T10:00:00.0000000Z > tsc -p tsconfig.json",
  "ci\ttypecheck\t2026-10-30T10:00:01.0000000Z src/merge.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "ci\ttypecheck\t2026-10-30T10:00:02.0000000Z Process completed with exit code 2.",
].join("\n");

const check = (name: string, conclusion: string | null, job?: number): FakeCheck => ({
  name,
  conclusion,
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  workflowName: "CI",
  ...(job ? { detailsUrl: `${REPO}/actions/runs/9000/job/${job}` } : {}),
});

function pr(number: number, branch: string, rollup: FakeCheck[], over: Partial<FakePr> = {}): FakePr {
  return {
    number,
    state: "OPEN",
    title: `${branch}: the change`,
    url: `${REPO}/pull/${number}`,
    isDraft: false,
    additions: 40,
    deletions: 3,
    reviewDecision: "APPROVED",
    updatedAt: "2026-10-30T10:00:00Z",
    autoMergeRequest: null,
    statusCheckRollup: rollup,
    mergeable: "MERGEABLE",
    ...over,
  };
}

const BRANCHES = ["fix-ci", "review-notes", "slow-ci", "queued", "phone-pr"] as const;

const PRS: Record<string, FakePr> = {
  "fix-ci": pr(301, "fix-ci", [check("typecheck", "FAILURE", 22), check("unit", "SUCCESS")]),
  "review-notes": pr(302, "review-notes", [check("unit", "SUCCESS")], { reviewDecision: null }),
  "slow-ci": pr(303, "slow-ci", [check("unit", null)]),
  queued: pr(304, "queued", [check("unit", "SUCCESS")]),
  // The phone's: a failing check and an open thread, so all three actions show.
  "phone-pr": pr(305, "phone-pr", [check("typecheck", "FAILURE", 23), check("unit", "SUCCESS")]),
};

const thread = (n: number, path: string, line: number, body: string) => ({
  isResolved: false,
  isOutdated: false,
  path,
  line,
  comments: {
    nodes: [
      {
        author: { __typename: "User", login: "reviewer-jane" },
        body,
        url: `${REPO}/pull/302#discussion_r${n}`,
        createdAt: "2026-10-30T09:30:00Z",
      },
    ],
  },
});

const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    const projectPath = path.join(tempHome, "test-project");
    const originPath = path.join(tempHome, "origin.git");
    execSync(`git init --bare "${originPath}"`);
    execSync(`git remote add origin "${originPath}"`, { cwd: projectPath });
    execSync("git push -u origin main", { cwd: projectPath, stdio: "ignore" });

    const worktreeRoot = path.join(tempHome, "worktrees");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const workspaces = BRANCHES.map((branch) => {
      const wtPath = path.join(worktreeRoot, branch);
      execSync(`git worktree add "${wtPath}" -b "${branch}"`, { cwd: projectPath, stdio: "ignore" });
      return { path: wtPath, branch, isMain: false, name: null, linkedIssues: [] };
    });

    const seed = {
      projects: [
        {
          id: "proj-pr-actions",
          name: "acme-app",
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
          color: null,
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
      prs: PRS,
      conversations: {
        302: {
          isInMergeQueue: false,
          reviewThreads: {
            nodes: [
              thread(1, "src/merge.ts", 42, "Handle a repo that allows no method at all."),
              thread(2, "src/PrActions.tsx", 118, "The caret should move with the button."),
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          reviews: { totalCount: 0, nodes: [] },
        },
        305: {
          isInMergeQueue: false,
          reviewThreads: { nodes: [thread(3, "src/PrActions.tsx", 64, "Say why Merge is off, in words.")] },
          comments: { totalCount: 0, nodes: [] },
          reviews: { totalCount: 0, nodes: [] },
        },
      },
      // (conversations above) plus #305's one thread, for the phone.
      repo: {
        viewerDefaultMergeMethod: "SQUASH",
        squashMergeAllowed: true,
        mergeCommitAllowed: false,
        rebaseMergeAllowed: true,
        autoMergeAllowed: true,
      },
      mergeQueue: [304],
      jobLogs: { "22": FAILING_LOG, "23": FAILING_LOG },
    });
    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
    const app = await launchApp(tempHome);
    process.env.PATH = originalPath;
    await use(app);
    await killApp(app);
  },
});

function row(window: Page, branch: string): Locator {
  return window.locator(`[data-testid="workspace-item"][data-workspace-path$="/${branch}"]`);
}

/** Hover the workspace's PR badge until its card is open, and return the card. */
async function openCard(window: Page, branch: string): Promise<Locator> {
  const card = window.locator('[class*="prPopover"][data-state="open"]').first();
  // A hover can land while the sidebar is still re-rendering under load and
  // never reach the badge's enter handler: move off and hover again.
  await expect(async () => {
    await window.mouse.move(900, 700);
    await row(window, branch).locator("[data-readiness]").hover();
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(card.getByTestId("pr-actions")).toBeVisible({ timeout: 10_000 });
  return card;
}

/**
 * Hover a badge (which refetches PRs) until `done`: what GitHub changed
 * between polls reaches the app without waiting out the poll interval.
 */
async function refreshUntil(window: Page, done: () => Promise<boolean>): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        await window.mouse.move(900, 700);
        await window.locator("[data-readiness]").first().hover();
        await window.waitForTimeout(600);
        await window.mouse.move(900, 700);
        return done();
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
}

/** A new agent tab's pane, once its brief has been echoed. */
async function briefInNewAgent(window: Page, tempHome: string, needle: string): Promise<string> {
  await expect(window.locator('[data-testid="terminal-pane"]').first()).toBeVisible({ timeout: 30_000 });
  const paneId = await activePaneId(window);
  await expect.poll(() => scrollback(tempHome, paneId), { timeout: 20_000 }).toContain(needle);
  return scrollback(tempHome, paneId);
}

test("a failing PR is fixed by an agent and merged, and the rest of the footer", async ({ window, tempHome }) => {
  test.setTimeout(240_000);
  const strip = new Filmstrip("pr-actions");
  window.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  window.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[console] ${msg.text()}`);
  });
  await expect(window.locator("[data-readiness]")).toHaveCount(BRANCHES.length, { timeout: 60_000 });

  // ── 1. Failing check: merge is held, the agent gets the log ─────────────
  let card = await openCard(window, "fix-ci");
  const merge = card.getByTestId("pr-merge");
  await expect(merge).toBeDisabled();
  await expect(merge).toHaveAttribute("title", "Fix the failing checks first");
  await expect(card.getByTestId("pr-merge-reason")).toHaveText("Fix the failing checks first");
  await useTheme(window, "Catppuccin Mocha");
  card = await openCard(window, "fix-ci");
  await strip.shot(window, "failing-check-card");
  await useTheme(window, "Catppuccin Latte");
  card = await openCard(window, "fix-ci");
  await strip.shot(window, "failing-check-card-light");
  await useTheme(window, "Catppuccin Mocha");
  card = await openCard(window, "fix-ci");

  await card.getByTestId("pr-fix-checks").click();
  await expect(card).not.toBeVisible({ timeout: 10_000 });
  const brief = await briefInNewAgent(window, tempHome, "error TS2322");
  expect(brief).toContain("typecheck (CI)");
  expect(brief).toContain(`${REPO}/actions/runs/9000/job/22`);
  expect(brief).not.toContain("2026-10-30T10:00:01");
  expect(fakeGhCalls(tempHome)).toContain("run view --job 22 --log-failed");
  await strip.shot(window, "agent-briefed-on-failing-check");

  // ── 2. The agent's push turns CI green; Merge is offered, repo default ──
  editFakePr(tempHome, 301, (node) => {
    const contexts = (node.commits as { nodes: { commit: { statusCheckRollup: { contexts: { nodes: FakeCheck[] } } } }[] })
      .nodes[0].commit.statusCheckRollup.contexts.nodes;
    for (const c of contexts) c.conclusion = "SUCCESS";
  });
  await refreshUntil(
    window,
    async () => (await row(window, "fix-ci").locator("[data-readiness]").getAttribute("data-readiness")) === "ready",
  );
  card = await openCard(window, "fix-ci");
  await expect(card.getByTestId("pr-merge")).toHaveText("Squash and merge");
  await expect(card.getByTestId("pr-merge")).toBeEnabled();
  await expect(card.getByTestId("pr-delete-after-merge")).toHaveAttribute("data-state", "checked");
  await card.getByTestId("pr-merge-method").click();
  await expect(card.getByTestId("pr-merge-method-squash")).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("pr-merge-method-rebase")).toBeVisible();
  await expect(card.getByTestId("pr-merge-method-merge")).toHaveCount(0);
  await strip.shot(window, "merge-method-menu");
  await window.keyboard.press("Escape");
  await useTheme(window, "Catppuccin Latte");
  card = await openCard(window, "fix-ci");
  await card.getByTestId("pr-merge-method").click();
  await expect(card.getByTestId("pr-merge-method-squash")).toBeVisible();
  await strip.shot(window, "merge-method-menu-light");
  await window.keyboard.press("Escape");
  await useTheme(window, "Catppuccin Mocha");
  card = await openCard(window, "fix-ci");
  await strip.shot(window, "ready-to-merge");
  await useTheme(window, "Catppuccin Latte");
  card = await openCard(window, "fix-ci");
  await strip.shot(window, "ready-to-merge-light");
  await useTheme(window, "Catppuccin Mocha");
  card = await openCard(window, "fix-ci");

  // ── 3. Merge: gh is asked to squash, the moment plays, the workspace goes ─
  await card.getByTestId("pr-merge").click();
  await expect(card.locator('[data-phase="merged"]')).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTestId("pr-state")).toHaveText("Merged");
  await strip.shot(window, "merged-moment");
  expect(fakeGhCalls(tempHome)).toContain("pr merge 301 --squash");
  await expect(row(window, "fix-ci")).toHaveCount(0, { timeout: 30_000 });
  await strip.shot(window, "workspace-removed-after-merge");

  // ── 4. Unresolved threads, each with file and line ──────────────────────
  card = await openCard(window, "review-notes");
  await expect(card.getByTestId("pr-address-comments")).toHaveText(/Address 2 comments/);
  await strip.shot(window, "unresolved-threads-card");
  await card.getByTestId("pr-address-comments").click();
  const notes = await briefInNewAgent(window, tempHome, "src/PrActions.tsx:118");
  expect(notes).toContain("src/merge.ts:42");
  expect(notes).toContain("Handle a repo that allows no method at all.");

  // ── 5. Pending checks arm auto-merge; the workspace stays ───────────────
  card = await openCard(window, "slow-ci");
  await expect(card.getByTestId("pr-merge")).toHaveText("Merge when ready");
  await strip.shot(window, "merge-when-ready");
  await card.getByTestId("pr-merge").click();
  await expect(card.locator('[data-phase="auto"]')).toBeVisible({ timeout: 10_000 });
  expect(fakeGhCalls(tempHome)).toContain("pr merge 303 --squash --auto");
  await strip.shot(window, "auto-merge-armed");
  await expect(row(window, "slow-ci")).toHaveCount(1);

  // ── 6. Merge queue: queued now, workspace goes when the queue lands it ──
  card = await openCard(window, "queued");
  await expect(card.getByTestId("pr-merge")).toHaveText("Add to merge queue");
  await strip.shot(window, "add-to-merge-queue");
  await card.getByTestId("pr-merge").click();
  await expect(card.locator('[data-phase="queued"]')).toBeVisible({ timeout: 10_000 });
  expect(fakeGhCalls(tempHome)).toContain("pr merge 304 --squash");
  await strip.shot(window, "queued-to-merge");
  await window.mouse.move(900, 700);
  await expect(row(window, "queued")).toHaveCount(1);

  editFakePr(tempHome, 304, (node) => {
    node.state = "MERGED";
    node.isInMergeQueue = false;
  });
  await refreshUntil(window, async () => (await row(window, "queued").count()) === 0);
  await strip.shot(window, "queued-workspace-removed-on-land");

  // ── 7. With the box unticked the workspace stays, its badge merged ──────
  card = await openCard(window, "review-notes");
  await card.getByTestId("pr-delete-after-merge").click();
  await expect(card.getByTestId("pr-delete-after-merge")).toHaveAttribute("data-state", "unchecked");
  await card.getByTestId("pr-merge").click();
  await expect(card.getByTestId("pr-state")).toHaveText("Merged", { timeout: 10_000 });
  expect(fakeGhCalls(tempHome)).toContain("pr merge 302 --squash");
  await expect(row(window, "review-notes").locator("[data-readiness]")).toHaveAttribute(
    "data-readiness",
    "merged",
    { timeout: 30_000 },
  );
  await window.mouse.move(900, 700);
  await strip.shot(window, "kept-workspace-badge-merged");
});

test("the phone's PR sheet carries the same footer", async ({ app, window, tempHome, request }) => {
  test.setTimeout(180_000);
  const strip = new Filmstrip("pr-actions-phone");
  await expect(window.locator("[data-readiness]")).toHaveCount(BRANCHES.length, { timeout: 60_000 });

  // A chat-capable agent in the failing PR's workspace: the phone reaches
  // the PR through the chat's status line.
  await row(window, "phone-pr").click();
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  const chatDir = path.join(tempHome, "fake-chat");
  await runInTerminal(
    window,
    `"${FAKE_AGENT_TRANSCRIPT}" "${path.join(chatDir, "transcript.jsonl")}" "${path.join(chatDir, "input.log")}" e2e-pr-phone`,
  );
  await waitForVisibleSession(request, tempHome, { name: "e2e-pr-phone" });
  const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
  await pane.getByTestId("pane-chat-toggle").click();
  await expect(pane.getByTestId("chat-pane")).toBeVisible({ timeout: 20_000 });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(375, 812);
  });
  const chip = window.getByRole("button", { name: /^Pull request #305/ }).last();
  await expect(chip).toBeVisible({ timeout: 20_000 });

  for (const theme of ["Catppuccin Mocha", "Catppuccin Latte"] as const) {
    await useTheme(window, theme);
    await chip.click();
    const sheet = window.getByTestId("phone-pr-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByTestId("pr-fix-checks")).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByTestId("pr-address-comments")).toHaveText(/Address 1 comment/);
    await expect(sheet.getByTestId("pr-merge")).toBeVisible();
    await expect(sheet.getByTestId("pr-merge-reason")).toHaveText("Fix the failing checks first");
    const box = await sheet.getByTestId("pr-actions").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(375);
    await window.waitForTimeout(400);
    await strip.shot(window, `phone-sheet-${theme === "Catppuccin Latte" ? "light" : "dark"}`);
    await window.getByTestId("phone-pr-sheet-close").click();
    await expect(sheet).not.toBeVisible({ timeout: 5_000 });
  }
});

const CLI = path.join(__dirname, "..", "..", "dist-electron", "manor-cli.js");

test("the manor CLI briefs and merges the workspace's PR", async ({ window, tempHome }) => {
  test.setTimeout(180_000);
  await expect(window.locator("[data-readiness]")).toHaveCount(BRANCHES.length, { timeout: 60_000 });
  // The app's own spelling of each path (it resolves /var to /private/var).
  const paths = new Map<string, string>();
  for (const branch of BRANCHES) {
    paths.set(branch, (await row(window, branch).getAttribute("data-workspace-path")) ?? "");
  }
  const ws = (branch: string) => paths.get(branch)!;
  const home = path.dirname(path.dirname(ws("fix-ci")));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MANOR_"))),
    HOME: tempHome,
    PATH: `${path.join(tempHome, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const transcript: string[] = [];
  const manor = (...args: string[]): string => {
    const out = execFileSync("node", [CLI, ...args, "--project-id", "proj-pr-actions"], { env, encoding: "utf-8" });
    transcript.push(`$ manor ${args.join(" ").replaceAll(home, "~")}`, out.trim().replaceAll(home, "~"), "");
    return out;
  };

  expect(manor("fix-pr-checks", "--workspace-path", ws("fix-ci"), "--print")).toContain("error TS2322");
  expect(manor("address-pr-comments", "--workspace-path", ws("review-notes"), "--print")).toContain(
    "src/merge.ts:42",
  );
  expect(manor("fix-pr-checks", "--workspace-path", ws("fix-ci"))).toMatch(/Started a new agent in pane/);
  expect(manor("merge-pr", "--workspace-path", ws("slow-ci"), "--auto")).toContain("Auto-merge armed on PR #303");
  expect(manor("merge-pr", "--workspace-path", ws("queued"), "--delete-workspace")).toContain(
    "Added PR #304 to the merge queue",
  );

  editFakePr(tempHome, 301, (node) => {
    const contexts = (node.commits as { nodes: { commit: { statusCheckRollup: { contexts: { nodes: FakeCheck[] } } } }[] })
      .nodes[0].commit.statusCheckRollup.contexts.nodes;
    for (const c of contexts) c.conclusion = "SUCCESS";
  });
  const merged = manor("merge-pr", "--workspace-path", ws("fix-ci"), "--delete-workspace");
  expect(merged).toContain("Merged PR #301 (squash)");
  expect(merged).toContain("Removed workspace");
  expect(fakeGhCalls(tempHome)).toContain("pr merge 301 --squash");
  await expect(row(window, "fix-ci")).toHaveCount(0, { timeout: 30_000 });

  new Filmstrip("pr-actions-cli").write("cli-transcript.txt", transcript.join("\n"));
});
