import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { type ElectronApplication, type Page } from "@playwright/test";

import { expect, killApp, launchApp, test as base } from "./fixtures";
import { fakeGhCalls, installFakeGh, setFakeInbox, type FakeThread } from "./helpers/fake-gh";
import { closeSettings, openSettings } from "./helpers/settings";
import { useTheme } from "./helpers/theme";

/**
 * GitHub's inbox reaching the bell, against a fake `gh`: what's already there
 * stays quiet, a review request on a project's repo gets a row, everything out
 * of scope or switched off doesn't, and a relaunch neither repeats items nor
 * loses the ones that arrived while closed.
 *
 * Linear's source can't be pointed at a fake from here, so its rows are seeded
 * into the log to show them in the bell; `electron/inbox/inbox.test.ts` covers
 * how they're made. A banner can't be seen by a test (notification-center.spec).
 */

const POLL_MS = "400";

const thread = (id: string, reason: string, repo: string, kind: "pulls" | "issues", n: number): FakeThread => ({
  id,
  reason,
  repository: { full_name: repo },
  subject: {
    title: `Change number ${n}`,
    type: kind === "pulls" ? "PullRequest" : "Issue",
    url: `https://api.github.com/repos/${repo}/${kind}/${n}`,
  },
});

const dataDir = (tempHome: string) => path.join(tempHome, ".local", "share", "Manor");

interface Row {
  title: string;
  kind: string;
  target: { url?: string } | null;
}

function records(tempHome: string): Row[] {
  try {
    const raw = fs.readFileSync(path.join(dataDir(tempHome), "notifications.json"), "utf-8");
    return (JSON.parse(raw) as { notifications: Row[] }).notifications;
  } catch {
    return [];
  }
}

const titles = (tempHome: string) => records(tempHome).map((r) => r.title);

/** Whether the poller has finished the check that sets its baseline. */
function baselined(tempHome: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dataDir(tempHome), "inbox-notifications.json"), "utf-8");
    return typeof (JSON.parse(raw) as { github?: { since?: string } }).github?.since === "string";
  } catch {
    return false;
  }
}

/** Waits for checks made after this call, so what's asserted absent had its chance. */
async function twoMoreChecks(tempHome: string): Promise<void> {
  const inboxCalls = () => fakeGhCalls(tempHome).filter((c) => c.startsWith("api --include")).length;
  const start = inboxCalls();
  await expect.poll(inboxCalls, { timeout: 15_000 }).toBeGreaterThanOrEqual(start + 2);
}

const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    const projectPath = path.join(tempHome, "test-project");
    execSync("git remote add origin git@github.com:Acme/App.git", { cwd: projectPath });
    const dir = dataDir(tempHome);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "projects.json"),
      JSON.stringify({
        projects: [
          {
            id: "proj-inbox",
            name: "acme-app",
            path: projectPath,
            defaultBranch: "main",
            workspaces: [{ path: projectPath, branch: "main", isMain: true, name: null, linkedIssues: [] }],
            selectedWorkspaceIndex: 0,
            defaultRunCommand: null,
            worktreePath: null,
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
      }),
    );
    // A Linear row, to show it filed under Issues.
    fs.writeFileSync(
      path.join(dir, "notifications.json"),
      JSON.stringify({
        notifications: [
          {
            id: "seed-linear",
            kind: "linear-assigned",
            title: "Assigned: ENG-214",
            body: "Linear · Retry webhook deliveries",
            timestamp: new Date().toISOString(),
            read: false,
            target: { type: "url", url: "https://linear.app/acme/issue/ENG-214/retry" },
          },
        ],
      }),
    );
    const binDir = installFakeGh(tempHome, {
      prs: {},
      inbox: [thread("old", "review_requested", "Acme/App", "pulls", 100)],
    });
    const app = await launchApp(tempHome, {
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        MANOR_E2E_INBOX_POLL_MS: POLL_MS,
      },
    });
    await use(app);
    await killApp(app).catch(() => {});
  },
});

test("GitHub inbox items reach the bell by scope and toggle, and survive a relaunch", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  const shot = (name: string) => window.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const old = thread("old", "review_requested", "Acme/App", "pulls", 100);

  // The first check only records what's there.
  await expect.poll(() => baselined(tempHome), { timeout: 30_000 }).toBe(true);
  await twoMoreChecks(tempHome);
  expect(titles(tempHome)).toEqual(["Assigned: ENG-214"]);

  // Two in scope, and four that must produce nothing.
  const wanted = [
    thread("201", "review_requested", "Acme/App", "pulls", 201),
    thread("55", "mention", "Acme/App", "issues", 55),
  ];
  const ignored = [
    thread("300", "review_requested", "Other/Repo", "pulls", 300),
    thread("301", "subscribed", "Acme/App", "pulls", 301),
    thread("302", "comment", "Acme/App", "pulls", 302),
    thread("303", "ci_activity", "Acme/App", "pulls", 303),
  ];
  setFakeInbox(tempHome, [old, ...wanted, ...ignored]);
  await expect.poll(() => titles(tempHome).length, { timeout: 15_000 }).toBe(3);
  await twoMoreChecks(tempHome);
  expect(titles(tempHome).sort()).toEqual([
    "Assigned: ENG-214",
    "Mentioned in #55",
    "Review requested: #201",
  ]);
  expect(records(tempHome).find((r) => r.title === "Review requested: #201")?.target?.url).toBe(
    "https://github.com/Acme/App/pull/201",
  );

  // Clicking a row opens its page.
  await app.evaluate(({ shell }) => {
    (globalThis as { __opened?: string[] }).__opened = [];
    shell.openExternal = async (url: string) => {
      (globalThis as unknown as { __opened: string[] }).__opened.push(url);
    };
  });

  // In the bell, with the filter sorting PRs from issues.
  await window.getByTestId("notifications-bell").click();
  const popover = window.getByTestId("notifications-popover");
  await expect(popover).toBeVisible({ timeout: 5_000 });
  const rows = popover.getByTestId("notification-row");
  await expect(rows).toHaveCount(3);
  await useTheme(window, "Catppuccin Mocha");
  await shot("bell-dark");
  await useTheme(window, "Catppuccin Latte");
  await shot("bell-light");
  const filter = window.getByTestId("notifications-filter");
  await filter.getByText("PRs", { exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Review requested: #201");
  await filter.getByText("Issues", { exact: true }).click();
  await expect(rows).toHaveCount(2);
  await shot("bell-issues-light");
  await filter.getByText("PRs", { exact: true }).click();
  await rows.first().click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toEqual(["https://github.com/Acme/App/pull/201"]);
  if (await popover.isVisible()) await window.keyboard.press("Escape");

  // Settings: GitHub's status and Linear's prompt, folded and expanded.
  await openSettings(window);
  await window.getByTestId("settings-nav-notifications").click();
  const github = window.getByTestId("inbox-card-github");
  const linear = window.getByTestId("inbox-card-linear");
  await expect(github).toContainText("tester · 1 repo from your projects · checked");
  await expect(linear).toContainText("Not connected");
  await expect(github.getByText("Team mentioned")).toHaveCount(0);
  await github.scrollIntoViewIfNeeded();
  await shot("settings-light");
  await linear.scrollIntoViewIfNeeded();
  await shot("settings-linear-light");
  await useTheme(window, "Catppuccin Mocha");
  await shot("settings-dark");
  await linear.getByRole("button", { name: "More types (5)" }).click();
  await expect(linear.getByText("Reactions")).toBeVisible();
  await linear.scrollIntoViewIfNeeded();
  await shot("settings-expanded-dark");

  // A Linear switch holds its value through closing Settings.
  const reactions = linear.locator("label", { hasText: "Reactions" }).getByRole("switch");
  await reactions.click();
  await closeSettings(window);
  await openSettings(window);
  await window.getByTestId("settings-nav-notifications").click();
  await expect(linear.locator("label", { hasText: "Reactions" }).getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Mentions off: one of those stays out, and a review request still arrives.
  await github
    .locator("label", { hasText: "Mentioned" })
    .getByRole("switch")
    .click();
  await closeSettings(window);
  setFakeInbox(tempHome, [
    old,
    ...wanted,
    ...ignored,
    thread("56", "mention", "Acme/App", "issues", 56),
    thread("202", "review_requested", "Acme/App", "pulls", 202),
  ]);
  await expect.poll(() => titles(tempHome), { timeout: 15_000 }).toContain("Review requested: #202");
  await twoMoreChecks(tempHome);
  expect(titles(tempHome)).not.toContain("Mentioned in #56");

  // Back on: the next mention arrives, and the one from while it was off doesn't.
  await openSettings(window);
  await window.getByTestId("settings-nav-notifications").click();
  await github.locator("label", { hasText: "Mentioned" }).getByRole("switch").click();
  await closeSettings(window);
  await twoMoreChecks(tempHome);
  const beforeOn = [
    old,
    ...wanted,
    ...ignored,
    thread("56", "mention", "Acme/App", "issues", 56),
    thread("202", "review_requested", "Acme/App", "pulls", 202),
  ];
  setFakeInbox(tempHome, [...beforeOn, thread("57", "mention", "Acme/App", "issues", 57)]);
  await expect.poll(() => titles(tempHome), { timeout: 15_000 }).toContain("Mentioned in #57");
  expect(titles(tempHome)).not.toContain("Mentioned in #56");

  // Closed: one arrives. Reopened: it appears once and nothing repeats.
  await killApp(app);
  setFakeInbox(tempHome, [
    old,
    ...wanted,
    ...ignored,
    thread("56", "mention", "Acme/App", "issues", 56),
    thread("202", "review_requested", "Acme/App", "pulls", 202),
    thread("57", "mention", "Acme/App", "issues", 57),
    thread("203", "review_requested", "Acme/App", "pulls", 203),
  ]);
  const binDir = path.join(tempHome, "bin");
  const reopened = await launchApp(tempHome, {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      MANOR_E2E_INBOX_POLL_MS: POLL_MS,
    },
  });
  try {
    await expect.poll(() => titles(tempHome), { timeout: 30_000 }).toContain("Review requested: #203");
    await twoMoreChecks(tempHome);
    const after = titles(tempHome);
    expect(after.filter((t) => t === "Review requested: #201")).toHaveLength(1);
    expect(after.filter((t) => t === "Review requested: #202")).toHaveLength(1);
    expect(after.filter((t) => t === "Review requested: #203")).toHaveLength(1);
    expect(after).not.toContain("Mentioned in #56");
  } finally {
    await killApp(reopened);
  }
});
