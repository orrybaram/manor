import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { type ElectronApplication, type Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";
import { CASES, type Case } from "./helpers/pr-badge-cases";

/**
 * Every state the PR badge can be in, rendered by the real app.
 *
 * One worktree per case, a fake `gh` on PATH answering that branch with the
 * payload the case describes, and the real fetcher / store / component doing
 * the rest — nothing reaches in to fabricate a badge. Each row is checked
 * three ways: the readiness the badge advertises, the lucide icon it drew,
 * and whether that icon is actually animating. The run writes a
 * self-contained report to the Desktop.
 */

/**
 * Reads its answers out of `$HOME/gh-fixtures`, written below, so the case
 * table stays in TypeScript instead of being duplicated into bash.
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

function prListJson(c: Case): string {
  return JSON.stringify([
    {
      number: c.number,
      state: c.state,
      title: `${c.branch}: ${c.note}`,
      url: `https://github.com/acme/app/pull/${c.number}`,
      isDraft: c.isDraft ?? false,
      additions: 10,
      deletions: 2,
      reviewDecision: c.reviewDecision,
      updatedAt: "2026-09-08T10:00:00Z",
      autoMergeRequest: c.autoMerge
        ? { enabledAt: "2026-09-08T10:00:00Z" }
        : null,
      statusCheckRollup: c.rollup,
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
          isInMergeQueue: c.inMergeQueue === true,
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

    // One real worktree per case: the sidebar only shows a PR badge on a
    // non-main workspace, and the app expects the path to exist.
    const worktreeRoot = path.join(tempHome, "worktrees");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const workspaces = CASES.map((c) => {
      const wtPath = path.join(worktreeRoot, c.branch);
      execSync(`git worktree add "${wtPath}" -b "${c.branch}"`, {
        cwd: projectPath,
        stdio: "ignore",
      });
      return {
        path: wtPath,
        branch: c.branch,
        isMain: false,
        name: null,
        linkedIssues: [],
      };
    });

    const seed = {
      projects: [
        {
          id: "proj-badge-matrix",
          name: "acme-app",
          path: projectPath,
          defaultBranch: "main",
          workspaces: [
            {
              path: projectPath,
              branch: "main",
              isMain: true,
              name: null,
              linkedIssues: [],
            },
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

    const dataDirs = [
      path.join(tempHome, "Library", "Application Support", "Manor"),
      path.join(tempHome, ".local", "share", "Manor"),
    ];
    for (const dir of dataDirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "projects.json"),
        JSON.stringify(seed, null, 2),
      );
    }

    const fixDir = path.join(tempHome, "gh-fixtures");
    fs.mkdirSync(fixDir, { recursive: true });
    for (const c of CASES) {
      fs.writeFileSync(path.join(fixDir, `pr-${c.branch}.json`), prListJson(c));
      fs.writeFileSync(
        path.join(fixDir, `gql-${c.number}.json`),
        graphqlJson(c),
      );
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

type Observed = {
  readiness: string | null;
  draft: string | null;
  icon: string | null;
  spinClass: boolean;
  animation: string;
  png: string;
};

test("every PR badge state, rendered by the app", async ({ app, window }) => {
  test.setTimeout(240_000);

  // Tall enough that all sixteen workspaces sit in the list at once, with no
  // scrollbar riding over the badges.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1200, 1500);
  });

  // The badges only exist once the poll has answered for every branch.
  const badges = window.locator("[data-readiness]");
  await expect(badges).toHaveCount(CASES.length, { timeout: 60_000 });

  const observed = new Map<string, Observed>();
  for (const c of CASES) {
    const row = window.locator(
      `[data-testid="workspace-item"][data-workspace-path$="/${c.branch}"]`,
    );
    await expect(row).toHaveCount(1);
    const badge = row.locator("[data-readiness]");

    const info = await badge.evaluate((el) => {
      const svg = el.querySelector("svg");
      const classes = Array.from(svg?.classList ?? []);
      return {
        readiness: el.getAttribute("data-readiness"),
        draft: el.getAttribute("data-draft"),
        // The lucide name, not the CSS-module hash.
        icon: classes.find((n) => n.startsWith("lucide-")) ?? null,
        spinClass: classes.some((n) => n.includes("prBadgeSpin")),
        animation: svg ? getComputedStyle(svg).animationName : "none",
      };
    });

    // The badge alone, not the whole row: captured on a retina window it is
    // ~2x its CSS size, so the report can show it pixel-for-pixel and stay
    // legible.
    const shot = await badge.screenshot({ animations: "disabled" });
    observed.set(c.branch, { ...info, png: shot.toString("base64") });
  }

  // Crop the hero shot to the sidebar: the rest of the window is empty
  // workspace and only makes the badges smaller on the page.
  const rows = window.locator('[data-testid="workspace-item"]');
  const boxes = await rows.evaluateAll((els) =>
    els
      .map((el) => el.getBoundingClientRect())
      .map((r) => ({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      })),
  );
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const sidebar = await window.screenshot({
    animations: "disabled",
    clip: {
      x: left,
      y: top - 8,
      width: right - left,
      height: bottom - top + 16,
    },
  });

  // ---- assertions -------------------------------------------------------
  const reportRows: string[] = [];
  for (const c of CASES) {
    const o = observed.get(c.branch)!;
    const spinning = o.animation !== "none" && o.animation !== "";

    expect(o.readiness, `${c.branch} readiness`).toBe(c.expect.readiness);
    expect(o.icon, `${c.branch} icon`).toBe(c.expect.icon);
    expect(spinning, `${c.branch} animating`).toBe(c.expect.spin);
    expect(o.spinClass, `${c.branch} spin class`).toBe(c.expect.spin);
    expect(o.draft, `${c.branch} draft flag`).toBe(
      c.isDraft ? "true" : "false",
    );

    reportRows.push(reportRow(c, o, spinning));
  }

  const out = path.join(os.homedir(), "Desktop");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "pr-badge-matrix.png"), sidebar);
  fs.writeFileSync(
    path.join(out, "pr-badge-matrix.html"),
    reportHtml(reportRows, sidebar.toString("base64")),
  );
});

function reportRow(c: Case, o: Observed, spinning: boolean): string {
  const cells = [
    `<td class="n">${c.number}</td>`,
    `<td><img src="data:image/png;base64,${o.png}" alt="${c.branch}"></td>`,
    `<td class="note">${c.note}</td>`,
    `<td><code>${o.readiness}</code></td>`,
    `<td><code>${o.icon}</code></td>`,
    `<td class="${spinning ? "spin" : "still"}">${spinning ? "spinning" : "static"}</td>`,
    `<td class="ok">PASS</td>`,
  ];
  return `<tr>${cells.join("")}</tr>`;
}

function reportHtml(rows: string[], sidebarPng: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>PR badge state matrix</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #11111b; color: #cdd6f4;
         font: 13px/1.5 -apple-system, system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 24px; color: #9399b2; }
  table { border-collapse: collapse; width: 100%; max-width: 1100px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase;
       letter-spacing: .07em; color: #9399b2; padding: 6px 10px;
       border-bottom: 1px solid #313244; }
  td { padding: 8px 10px; border-bottom: 1px solid #1e1e2e; vertical-align: middle; }
  td.n { color: #6c7086; font-variant-numeric: tabular-nums; }
  td.note { color: #bac2de; }
  td img { display: block; height: 28px; background: #1e1e2e;
           border-radius: 4px; padding: 3px 5px; }
  code { font: 11px ui-monospace, monospace; color: #89b4fa; }
  .spin { color: #f9e2af; }
  .still { color: #6c7086; }
  .ok { color: #a6e3a1; font-weight: 600; }
  figure { margin: 32px 0 0; max-width: 1100px; }
  figure img { height: auto; width: 420px; border: 1px solid #313244;
               border-radius: 8px; }
  figcaption { color: #9399b2; margin-top: 8px; }
</style>
<h1>PR badge state matrix</h1>
<p class="sub">Every case rendered by the real app: real fetcher, real store,
real component. A fake <code>gh</code> answers one branch per case; each row was
read back out of the live DOM.</p>
<table>
  <tr>
    <th>PR</th><th>Badge as rendered</th><th>Case</th>
    <th>Readiness</th><th>Icon</th><th>Motion</th><th>Assert</th>
  </tr>
  ${rows.join("\n  ")}
</table>
<figure>
  <img src="data:image/png;base64,${sidebarPng}" alt="sidebar">
  <figcaption>All ${rows.length} badges in one sidebar.</figcaption>
</figure>
`;
}
