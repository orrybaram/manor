import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { type ElectronApplication, type Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import { activePaneId, scrollback } from "./helpers/terminal";

/**
 * The sidebar PR surface, end to end: badge readiness and CI colour, the
 * popover's queued row, HTML comment bodies, bodiless comments dropped, the
 * send-to-agent action, hover-to-read notifications, folder placement from
 * the New Workspace dialog, the diff tree's count size, and a folder
 * scrolling its members into view when expanded.
 *
 * A fake `gh` on PATH answers the PR poll with three canned PRs so the badge,
 * popover and comment list render real data through the real fetcher; nothing
 * reaches into the app to fabricate state. Everything else is driven through
 * the UI, with a filmstrip under `tests/e2e/artifacts/sidebar-tweaks/`.
 */

const FAKE_GH = `#!/bin/bash
# Fake gh for the evidence run. Answers auth, pr list, and the conversation
# GraphQL query with canned data keyed by branch / PR number.
sub="$1 $2"
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
    case "$head" in
      api-auth)
        cat <<'JSON'
[{"number":101,"state":"OPEN","title":"Auth: rotate signing keys","url":"https://github.com/acme/app/pull/101","isDraft":false,"additions":120,"deletions":14,"reviewDecision":"APPROVED","updatedAt":"2026-09-08T10:00:00Z","autoMergeRequest":{"enabledAt":"2026-09-08T10:00:00Z"},"statusCheckRollup":[{"name":"unit","conclusion":"SUCCESS","workflowName":"CI"},{"name":"lint","conclusion":"SUCCESS","workflowName":"CI"}]}]
JSON
        ;;
      ui-fix)
        cat <<'JSON'
[{"number":102,"state":"OPEN","title":"Sidebar: folder polish","url":"https://github.com/acme/app/pull/102","isDraft":false,"additions":40,"deletions":9,"reviewDecision":"REVIEW_REQUIRED","updatedAt":"2026-09-08T10:00:00Z","autoMergeRequest":null,"statusCheckRollup":[{"name":"unit","conclusion":"SUCCESS","workflowName":"CI"},{"name":"e2e","conclusion":null,"status":"IN_PROGRESS","workflowName":"CI"}]}]
JSON
        ;;
      hotfix)
        cat <<'JSON'
[{"number":103,"state":"OPEN","title":"Hotfix: null deref","url":"https://github.com/acme/app/pull/103","isDraft":false,"additions":3,"deletions":1,"reviewDecision":"APPROVED","updatedAt":"2026-09-08T10:00:00Z","autoMergeRequest":null,"statusCheckRollup":[{"name":"unit","conclusion":"FAILURE","workflowName":"CI"},{"name":"lint","conclusion":"SUCCESS","workflowName":"CI"}]}]
JSON
        ;;
      *) echo "[]" ;;
    esac
    exit 0 ;;
  "api graphql")
    num=$(printf '%s' "$*" | grep -o 'number: [0-9]*' | grep -o '[0-9]*')
    case "$num" in
      102)
        cat <<'JSON'
{"data":{"repository":{"pullRequest":{"isInMergeQueue":false,"reviewThreads":{"nodes":[{"isResolved":false,"path":"src/auth/session.ts","comments":{"nodes":[{"author":{"login":"reviewer-jane"},"body":"Please hash with <code>bcrypt</code> here, not MD5.<br><details><summary>Why</summary>MD5 has been broken since 2004.</details><img src=\\"https://example.invalid/s.png\\" alt=\\"screenshot\\">","url":"https://github.com/acme/app/pull/102#discussion_r1","createdAt":"2026-09-08T09:30:00Z"}]}},{"isResolved":true,"path":"src/ui/Sidebar.tsx","comments":{"nodes":[{"author":{"login":"reviewer-sam"},"body":"nit: rename","url":"https://github.com/acme/app/pull/102#discussion_r2","createdAt":"2026-09-08T08:00:00Z"}]}}]},"comments":{"totalCount":2,"nodes":[{"author":{"login":"bot-ci"},"body":"","url":"https://github.com/acme/app/pull/102#issuecomment-1","createdAt":"2026-09-08T09:00:00Z"},{"author":{"login":"reviewer-jane"},"body":"Overall looks solid. **One blocker** inline.","url":"https://github.com/acme/app/pull/102#issuecomment-2","createdAt":"2026-09-08T09:31:00Z"}]},"reviews":{"totalCount":2,"nodes":[{"author":{"login":"reviewer-jane"},"body":"","url":"https://github.com/acme/app/pull/102#pullrequestreview-1","submittedAt":"2026-09-08T09:29:00Z","state":"COMMENTED"},{"author":{"login":"reviewer-sam"},"body":"","url":"https://github.com/acme/app/pull/102#pullrequestreview-2","submittedAt":"2026-09-08T08:30:00Z","state":"APPROVED"}]}}}}}
JSON
        ;;
      *)
        echo '{"data":{"repository":{"pullRequest":{"isInMergeQueue":false,"reviewThreads":{"nodes":[]},"comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]}}}}}'
        ;;
    esac
    exit 0 ;;
  *)
    echo "fake gh: unsupported: $*" >&2
    exit 1 ;;
esac
`;

const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    const projectPath = path.join(tempHome, "test-project");

    // The seeded repo needs an origin so the dialog's branch lists resolve.
    const originPath = path.join(tempHome, "origin.git");
    execSync(`git init --bare "${originPath}"`);
    execSync(`git remote add origin "${originPath}"`, { cwd: projectPath });
    execSync("git push -u origin main", { cwd: projectPath });

    const seed = {
      projects: [
        {
          id: "proj-evidence",
          name: "acme-app",
          path: projectPath,
          defaultBranch: "main",
          workspaces: [
            { path: projectPath, branch: "main", isMain: true, name: null, linkedIssues: [] },
          ],
          workspaceFolders: [
            { id: "folder-backend", name: "Backend" },
            { id: "folder-frontend", name: "Frontend" },
          ],
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
    };

    const now = Date.now();
    const notifications = {
      notifications: [
        {
          id: "n-1",
          kind: "pr-comment",
          title: "New comment on #102",
          body: "Overall looks solid. One blocker inline.",
          timestamp: new Date(now - 5 * 60_000).toISOString(),
          read: false,
          target: { type: "url", url: "https://github.com/acme/app/pull/102" },
          comment: {
            author: "reviewer-jane",
            body: "Overall looks solid. **One blocker** inline.",
            url: "https://github.com/acme/app/pull/102#issuecomment-2",
            createdAt: new Date(now - 5 * 60_000).toISOString(),
          },
        },
        {
          id: "n-2",
          kind: "pr-checks-failed",
          title: "Checks failed on #103",
          body: "unit failed",
          timestamp: new Date(now - 20 * 60_000).toISOString(),
          read: false,
          target: { type: "url", url: "https://github.com/acme/app/pull/103" },
        },
        {
          id: "n-3",
          kind: "pr-approved",
          title: "#101 approved",
          body: "reviewer-sam approved",
          timestamp: new Date(now - 60 * 60_000).toISOString(),
          read: true,
          target: { type: "url", url: "https://github.com/acme/app/pull/101" },
        },
      ],
    };

    const dataDirs = [
      path.join(tempHome, "Library", "Application Support", "Manor"),
      path.join(tempHome, ".local", "share", "Manor"),
    ];
    for (const dir of dataDirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(seed, null, 2));
      fs.writeFileSync(path.join(dir, "notifications.json"), JSON.stringify(notifications, null, 2));
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

async function createWorkspaceInFolder(
  window: Page,
  name: string,
  folderLabel: string | null,
  strip: Filmstrip,
  shotName?: string,
): Promise<void> {
  await window.keyboard.press("Meta+Shift+n");
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await window.locator('[data-testid="new-workspace-name-input"]').fill(name);
  if (folderLabel) {
    await window.locator('[data-testid="new-workspace-folder-select"]').click();
    await window.getByRole("option", { name: folderLabel }).click();
  }
  if (shotName) await strip.shot(window, shotName);
  await window.locator('[data-testid="new-workspace-submit"]').click();
  await expect(dialog).not.toBeVisible({ timeout: 20_000 });
}

test("sidebar PR badge, popover, notifications, folders and diff tree", async ({ app, window, tempHome }) => {
  test.setTimeout(180_000);
  const strip = new Filmstrip("sidebar-tweaks");
  const log: string[] = [];

  await expect(window.locator('[data-testid="workspace-item"]').first()).toBeVisible({
    timeout: 15_000,
  });

  // ── 1. New workspace dialog: folder select ───────────────────────────────
  await createWorkspaceInFolder(window, "api-auth", "Backend", strip, "new-workspace-folder-select");
  await createWorkspaceInFolder(window, "ui-fix", "Frontend", strip);
  await createWorkspaceInFolder(window, "hotfix", null, strip);

  const items = window.locator('[data-testid="workspace-item"]');
  await expect(items).toHaveCount(4, { timeout: 15_000 });

  // The folder members live under the folder body; api-auth must sit inside Backend.
  const backendBody = window.locator('[class*="folderBody"]').first();
  await expect(backendBody.locator('[data-testid="workspace-item"]', { hasText: "api-auth" })).toHaveCount(1);
  log.push("api-auth created inside folder Backend via dialog folder select: yes");

  // ── 2. PR badges: queued (blue) + check-tone text ────────────────────────
  const badges = window.locator("[data-readiness]");
  await expect(badges).toHaveCount(3, { timeout: 30_000 });
  const readinessByText: Record<string, string> = {};
  for (let i = 0; i < 3; i++) {
    const b = badges.nth(i);
    const text = (await b.textContent()) ?? "";
    readinessByText[text.trim()] = (await b.getAttribute("data-readiness")) ?? "";
  }
  log.push(`badge readiness: ${JSON.stringify(readinessByText)}`);
  expect(readinessByText["#101"]).toBe("queued");
  expect(readinessByText["#102"]).toBe("blocked");
  expect(readinessByText["#103"]).toBe("blocked");

  const colorOf = async (n: number) =>
    badges.nth(n).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor };
    });
  for (let i = 0; i < 3; i++) {
    const text = ((await badges.nth(i).textContent()) ?? "").trim();
    log.push(`badge ${text} computed: ${JSON.stringify(await colorOf(i))}`);
  }
  await strip.shot(window, "pr-badges");

  // ── 3. Popover: queued row on #101 ───────────────────────────────────────
  const queuedBadge = badges.filter({ hasText: "#101" });
  await queuedBadge.hover();
  await expect(window.getByText("Queued to merge")).toBeVisible({ timeout: 5_000 });
  await strip.shot(window, "popover-queued-to-merge");
  await window.mouse.move(600, 600);
  await expect(window.getByText("Queued to merge")).not.toBeVisible({ timeout: 5_000 });

  // ── 4. Popover: HTML rendered, bodiless comments gone, send-to-agent ─────
  const blockedBadge = badges.filter({ hasText: "#102" });
  await blockedBadge.hover();
  const popover = window.locator('[class*="prPopover"][data-state="open"]').first();
  await expect(popover).toBeVisible({ timeout: 5_000 });
  await expect(popover.locator("details summary", { hasText: "Why" })).toBeVisible();
  await expect(popover.locator("code", { hasText: "bcrypt" })).toBeVisible();
  const commentAuthors = await popover.locator('[class*="prPopoverCommentAuthor"]').allTextContents();
  log.push(`popover comment authors (bodiless dropped): ${JSON.stringify(commentAuthors)}`);
  expect(commentAuthors).toHaveLength(3); // jane thread, jane comment, sam resolved thread
  await expect(popover.getByText("No comment text.")).toHaveCount(0);

  const unresolvedRow = popover.locator('[class*="prPopoverCommentUnresolved"]').first();
  await unresolvedRow.hover();
  const sendButton = unresolvedRow.getByRole("button", { name: "Send this comment to an agent" });
  await expect(sendButton).toBeVisible();
  await strip.shot(window, "popover-html-and-send-to-agent");

  await sendButton.click();
  await expect(popover).not.toBeVisible({ timeout: 5_000 });
  await expect(window.locator('[data-testid="terminal-pane"]').first()).toBeVisible({ timeout: 30_000 });
  const paneId = await activePaneId(window);
  await expect
    .poll(() => scrollback(tempHome, paneId), { timeout: 20_000 })
    .toContain("Address this unresolved review comment");
  const sb = scrollback(tempHome, paneId);
  const promptLine = sb.split("\n").find((l) => l.includes("AGENT_PROMPT") || l.includes("Address this"));
  log.push(`agent pane scrollback line: ${promptLine?.trim()}`);
  await strip.shot(window, "agent-tab-with-comment-prompt");

  // ── 5. Notifications: hover 3s marks read ────────────────────────────────
  await window.locator('[data-testid="notifications-bell"]').click();
  const rows = window.locator('[data-testid="notification-row"]');
  await expect(rows).toHaveCount(3, { timeout: 5_000 });
  const target = rows.filter({ hasText: "Checks failed on #103" });
  await expect(target).toHaveAttribute("data-read", "false");
  await strip.shot(window, "notifications-before-hover");
  await target.hover();
  await window.waitForTimeout(1500);
  await expect(target).toHaveAttribute("data-read", "false");
  await window.waitForTimeout(2200);
  await expect(target).toHaveAttribute("data-read", "true", { timeout: 3_000 });
  log.push("notification 'Checks failed on #103' read after ~3.5s hover: yes; still unread at 1.5s: yes");
  await strip.shot(window, "notifications-after-3s-hover");
  await window.keyboard.press("Escape");

  // ── 6. Diff file tree: smaller counts ────────────────────────────────────
  const uiFixItem = items.filter({ hasText: "ui-fix" });
  await uiFixItem.click();
  // The worktree's path comes from git itself rather than a guess at Manor's
  // layout: the branch is the one thing the test named.
  const projectPath = path.join(tempHome, "test-project");
  const worktrees = execSync("git worktree list --porcelain", { cwd: projectPath }).toString();
  const uiFixPath = worktrees
    .split("\n\n")
    .find((block) => block.includes("branch refs/heads/ui-fix"))
    ?.match(/^worktree (.+)$/m)?.[1];
  expect(uiFixPath, "ui-fix worktree path").toBeTruthy();
  fs.writeFileSync(path.join(uiFixPath!, "src-a.ts"), "export const a = 1;\nexport const b = 2;\n");
  fs.writeFileSync(path.join(uiFixPath!, "README.md"), "# ui-fix\n\nchanged\n");
  fs.writeFileSync(path.join(uiFixPath!, ".gitkeep"), "changed\n");
  await window.keyboard.press("Meta+Shift+g");
  const rowStats = window.locator('[class*="rowStats"]').first();
  await expect(rowStats).toBeVisible({ timeout: 20_000 });
  const fontSize = await rowStats.evaluate((el) => getComputedStyle(el).fontSize);
  log.push(`diff file-tree rowStats font-size: ${fontSize} (was 11px)`);
  expect(fontSize).toBe("9px");
  await strip.shot(window, "diff-file-tree-counts");

  // ── 7. Folder expand scrolls members into view ───────────────────────────
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1100, 420);
  });
  await window.waitForTimeout(400);
  const frontendHeader = window.locator('[class*="folderHeader"]', { hasText: "Frontend" });
  await frontendHeader.click(); // collapse
  await window.waitForTimeout(300);
  await strip.shot(window, "folder-collapsed-short-window");
  await frontendHeader.click(); // expand -> should scroll
  await window.waitForTimeout(900);
  const member = window.locator('[data-testid="workspace-item"]', { hasText: "ui-fix" });
  const visible = await member.evaluate((el) => {
    const scroller = el.closest('[class*="content"]') as HTMLElement | null;
    const r = el.getBoundingClientRect();
    const s = scroller?.getBoundingClientRect();
    return s ? { inView: r.bottom <= s.bottom + 1 && r.top >= s.top - 1, member: [r.top, r.bottom], scroller: [s.top, s.bottom] } : null;
  });
  log.push(`after expanding Frontend at 420px window, ui-fix in sidebar viewport: ${JSON.stringify(visible)}`);
  expect(visible?.inView).toBe(true);
  await strip.shot(window, "folder-expanded-scrolled-into-view");

  strip.write("evidence.txt", log.join("\n") + "\n");
});
