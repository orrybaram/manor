import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { type ElectronApplication, type Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";

/**
 * The dashboard's Needs you cards, rendered by the real app from PRs a fake
 * `gh` reports: one worktree per blocked/ready state. Checks that every card
 * shows up with its actions and that no action spills out of its card, and
 * writes screenshots of the panel at a wide and a narrow window to
 * `tests/e2e/artifacts/needs-you/` for eyeballing the layout.
 */

const FAKE_GH = `#!/bin/bash
sub="$1 $2"
FIX="$HOME/gh-fixtures"
case "$sub" in
  "auth status")
    echo "Logged in to github.com account tester (keyring)"
    exit 0 ;;
  "pr list")
    head=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--head" ]; then head="$a"; fi
      prev="$a"
    done
    if [ -f "$FIX/pr-$head.json" ]; then cat "$FIX/pr-$head.json"; else echo "[]"; fi
    exit 0 ;;
  "api graphql")
    num=$(printf '%s' "$*" | grep -o 'number: [0-9]*' | grep -o '[0-9]*')
    if [ -f "$FIX/gql-$num.json" ]; then
      cat "$FIX/gql-$num.json"
    else
      echo '{"data":{"repository":{"pullRequest":{"isInMergeQueue":false,"reviewThreads":{"nodes":[]},"comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]}}}}}'
    fi
    exit 0 ;;
  *)
    echo "fake gh: unsupported: $*" >&2
    exit 1 ;;
esac
`;

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
  /** The card's kind label. */
  kind: string;
  /** The card's primary action. */
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
    primary: "Fix with agent",
  },
  {
    branch: "changes",
    number: 94,
    title: "fix: debounce the sidebar resize",
    reviewDecision: "CHANGES_REQUESTED",
    rollup: [pass("unit")],
    kind: "Changes requested",
    primary: "Fix with agent",
  },
  {
    branch: "ready",
    number: 97,
    title: "chore: bump electron",
    reviewDecision: "APPROVED",
    rollup: [pass("unit"), pass("lint")],
    kind: "Ready to merge",
    primary: "Open PR",
  },
];

function prListJson(c: Case): string {
  return JSON.stringify([
    {
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
    },
  ]);
}

function graphqlJson(c: Case): string {
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
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          isInMergeQueue: false,
          reviewThreads: { nodes: threads },
          comments: { totalCount: 0, nodes: [] },
          reviews: { totalCount: 0, nodes: [] },
        },
      },
    },
  });
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
    const workspaces = CASES.map((c) => {
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

    const fixDir = path.join(tempHome, "gh-fixtures");
    fs.mkdirSync(fixDir, { recursive: true });
    for (const c of CASES) {
      fs.writeFileSync(path.join(fixDir, `pr-${c.branch}.json`), prListJson(c));
      fs.writeFileSync(path.join(fixDir, `gql-${c.number}.json`), graphqlJson(c));
    }

    const binDir = path.join(tempHome, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "gh"), FAKE_GH, { mode: 0o755 });
    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

    const app = await launchApp(tempHome);
    process.env.PATH = originalPath;
    await use(app);
    await killApp(app);
  },
});

const OUT = path.join(__dirname, "artifacts", "needs-you");

test("Needs you cards: every blocked/ready PR, actions inside the card", async ({
  app,
  window,
}) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });

  await window.getByTestId("home-row").click();
  const cards = window.locator("article[aria-label]");
  await expect(cards).toHaveCount(CASES.length, { timeout: 60_000 });

  for (const c of CASES) {
    const card = cards.filter({ hasText: `#${c.number}` });
    await expect(card, c.branch).toContainText(c.kind);
    await expect(card.getByText(c.primary, { exact: true }), c.branch).toBeVisible();
    await expect(card.getByRole("button", { name: "Open workspace" }), c.branch).toBeVisible();
    await expect(card.getByRole("button", { name: "Snooze for 1 hour" }), c.branch).toBeVisible();
  }

  for (const width of [1400, 1000, 760]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]?.setSize(w, 1000);
    }, width);
    await window.waitForTimeout(400);

    // Every action sits inside its card, and every action is one height.
    const layout = await cards.evaluateAll((els) =>
      els.map((card) => {
        const box = card.getBoundingClientRect();
        const actions = Array.from(card.querySelectorAll("footer a, footer button, div > a, div > button"))
          .filter((el) => card.contains(el))
          .map((el) => el.getBoundingClientRect());
        return {
          label: card.getAttribute("aria-label"),
          overflow: actions.some((a) => a.right > box.right - 1 || a.left < box.left),
          heights: [...new Set(actions.map((a) => Math.round(a.height)))],
        };
      }),
    );
    for (const l of layout) {
      expect(l.overflow, `${width}px ${l.label} overflow`).toBe(false);
      expect(l.heights, `${width}px ${l.label} action heights`).toHaveLength(1);
    }

    const panel = cards.first().locator("xpath=../..");
    await panel.screenshot({ path: path.join(OUT, `needs-you-${width}.png`), animations: "disabled" });
  }
});
