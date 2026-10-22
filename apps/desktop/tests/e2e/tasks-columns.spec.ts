import fs from "fs";
import path from "path";
import {
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";

/**
 * The Tasks table's columns (#376): resizing from a header edge, the Display
 * menu's Columns section and the header's right-click list, separate hidden
 * sets beside the drawer, and widths that survive a reload.
 *
 * A fake `gh` on PATH lists canned issues, so the table renders real rows
 * through the real GitHub tracker. Screenshots go to `MANOR_E2E_EVIDENCE`
 * when set, else the test's output dir.
 */

const EVIDENCE = process.env.MANOR_E2E_EVIDENCE;
const LIGHT_THEME = "E2E Light";

const ISSUES = [
  ["Allow dragging screenshots into an agent pane", 373, 6],
  ["Screenshot paste loses the image on remote hosts", 372, 13],
  ["Layout shifts when the sidebar collapses", 371, 19],
  ["perf: agent pane re-renders on every keystroke", 306, 60 * 24 * 20],
  ["Inline errors for the new workspace dialog", 327, 60 * 24 * 21],
  ["Readable diff colours in the light themes", 326, 60 * 24 * 21],
].map(([title, number, minutesAgo]) => ({
  number,
  title,
  url: `https://github.com/acme/app/issues/${number}`,
  state: "OPEN",
  labels: number === 372 ? [{ name: "bug", color: "d73a4a" }] : [],
  assignees: [{ login: "tester" }],
  updatedAt: new Date(
    Date.now() - (minutesAgo as number) * 60_000,
  ).toISOString(),
  author: { login: "orrybaram" },
  createdAt: "2026-09-01T10:00:00Z",
  closedAt: null,
  milestone: null,
  comments: [],
  stateReason: null,
  projectItems: [],
}));

/** `gh` answering the status check and both issue lists; anything else is empty. */
function installTasksGh(tempHome: string): string {
  const binDir = path.join(tempHome, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fixtures = path.join(tempHome, "gh-issues.json");
  fs.writeFileSync(fixtures, JSON.stringify(ISSUES));
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const sub = args.slice(0, 2).join(" ");
if (sub === "auth status") process.stdout.write("Logged in to github.com account tester (keyring)\\n");
else if (sub === "issue list") process.stdout.write(require("fs").readFileSync(${JSON.stringify(fixtures)}, "utf-8") + "\\n");
else if (sub === "api graphql") process.stdout.write('{"data":{}}\\n');
else process.stdout.write("[]\\n");
`,
    { mode: 0o755 },
  );
  return binDir;
}

function installLightTheme(tempHome: string): void {
  const palette = [
    "#24292f",
    "#cf222e",
    "#116329",
    "#4d2d00",
    "#0969da",
    "#8250df",
    "#1b7c83",
    "#6e7781",
    "#57606a",
    "#a40e26",
    "#1a7f37",
    "#633c01",
    "#218bff",
    "#a475f9",
    "#3192aa",
    "#8c959f",
  ];
  const body = [
    ...palette.map((c, i) => `palette = ${i}=${c}`),
    "background = #ffffff",
    "foreground = #1f2328",
    "cursor-color = #0969da",
    "selection-background = #dbe9f9",
    "selection-foreground = #1f2328",
    "",
  ].join("\n");
  for (const dir of [
    path.join(tempHome, "Library", "Application Support", "ghostty", "themes"),
    path.join(tempHome, ".config", "ghostty", "themes"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LIGHT_THEME), body);
  }
}

const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    installLightTheme(tempHome);
    const projectPath = path.join(tempHome, "test-project");
    const seed = {
      projects: [
        {
          id: "proj-tasks",
          name: "manor",
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
          ],
          workspaceFolders: [],
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
    for (const dir of [
      path.join(tempHome, "Library", "Application Support", "Manor"),
      path.join(tempHome, ".local", "share", "Manor"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "projects.json"),
        JSON.stringify(seed, null, 2),
      );
    }
    const binDir = installTasksGh(tempHome);
    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
    const app = await launchApp(tempHome);
    process.env.PATH = originalPath;
    await use(app);
    await killApp(app);
  },
});

async function shot(
  window: Page,
  name: string,
  target?: Locator,
): Promise<void> {
  // Past any popover's fade-in.
  await window.waitForTimeout(400);
  const file = EVIDENCE
    ? path.join(EVIDENCE, `${name}.png`)
    : test.info().outputPath(`${name}.png`);
  await (target ?? window).screenshot({ path: file });
}

async function openTasks(window: Page): Promise<void> {
  await window
    .getByText("Tasks", { exact: true })
    .first()
    .click({ timeout: 30_000 });
  await expect(window.getByTestId("task-row").first()).toBeVisible({
    timeout: 20_000,
  });
}

const header = (window: Page, name: string) =>
  window
    .getByTestId("tasks-head-row")
    .getByRole("columnheader")
    .filter({ has: window.getByRole("button", { name, exact: true }) });

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not laid out");
  return Math.round(box.width);
}

/** Drag a column's resize handle by `dx` pixels. */
async function dragHandle(
  window: Page,
  column: string,
  dx: number,
): Promise<void> {
  const handle = window.getByTestId(`task-column-resize-${column}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error("no handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx / 2, y, { steps: 4 });
  await window.mouse.move(x + dx, y, { steps: 4 });
  await window.mouse.up();
}

async function headerNames(window: Page): Promise<string[]> {
  return window
    .getByTestId("tasks-head-row")
    .getByRole("columnheader")
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
}

test.describe("Tasks table columns", () => {
  test.setTimeout(120_000);

  test("resize, hide and remember columns", async ({ window }) => {
    if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
    await window.setViewportSize({ width: 1280, height: 760 }).catch(() => {});
    await openTasks(window);
    await window.mouse.move(1, 400);
    await shot(window, "01-table-default-dark");

    // GitHub has no Priority column; the rest show at their defaults.
    await expect
      .poll(() => headerNames(window))
      .toEqual(["", "ID", "Title / Context", "Assignees", "Status", "Updated"]);
    const status = header(window, "Status");
    const title = header(window, "Title / Context");
    expect(await widthOf(status)).toBe(88);

    // Status sits right of Title, so its handle is its left edge: drag left widens it.
    const titleBefore = await widthOf(title);
    await dragHandle(window, "status", -60);
    expect(await widthOf(status)).toBe(148);
    expect(await widthOf(title)).toBe(titleBefore - 60);
    // Every row follows the header.
    const cell = window
      .getByTestId("task-row")
      .first()
      .getByRole("cell")
      .nth(4);
    expect(await widthOf(cell)).toBe(148);
    // Grabbing the handle didn't sort by Status.
    await expect(status).toHaveAttribute("aria-sort", "none");
    await window.mouse.move(1, 400);
    await shot(window, "02-status-widened");

    // Not below the column's minimum.
    await dragHandle(window, "status", 400);
    expect(await widthOf(status)).toBe(48);

    // Double-click resets it.
    await window.getByTestId("task-column-resize-status").dblclick();
    expect(await widthOf(status)).toBe(88);

    // ID resizes by its right edge; arrow keys nudge.
    await dragHandle(window, "id", 40);
    expect(await widthOf(header(window, "ID"))).toBe(120);
    await window.getByTestId("task-column-resize-id").focus();
    await window.keyboard.press("ArrowLeft");
    expect(await widthOf(header(window, "ID"))).toBe(112);

    // The Display menu: Sort, then Columns. Hiding Updated drops it everywhere.
    await window.getByTestId("tasks-display-menu").click();
    await expect(window.getByText("Sort by")).toBeVisible();
    await expect(window.getByText("Columns", { exact: true })).toBeVisible();
    await shot(window, "03-display-menu-dark");
    await window
      .getByRole("group", { name: "Columns" })
      .getByText("Updated")
      .click();
    await window.keyboard.press("Escape");
    await expect.poll(() => headerNames(window)).not.toContain("Updated");
    await expect(
      window.getByTestId("task-row").first().getByRole("cell"),
    ).toHaveCount(5);

    // The header's right-click list brings it back.
    await header(window, "Status").click({ button: "right" });
    const menu = window.getByTestId("tasks-columns-context-menu");
    await expect(menu).toBeVisible();
    await shot(window, "04-header-context-menu-dark");
    await menu.getByRole("menuitemcheckbox", { name: "Updated" }).click();
    await window.keyboard.press("Escape");
    await expect.poll(() => headerNames(window)).toContain("Updated");

    // Beside the drawer: its own set, with Assignees hidden by default.
    await window
      .getByTestId("task-row")
      .first()
      .getByText("by orrybaram")
      .click();
    await expect(window.getByTestId("task-drawer-resize-handle")).toBeVisible();
    await window.mouse.move(1, 400);
    await expect
      .poll(() => headerNames(window))
      .toEqual(["", "ID", "Title / Context", "Status", "Updated"]);
    await shot(window, "05-drawer-open-dark");
    await header(window, "Status").click({ button: "right" });
    await menu.getByRole("menuitemcheckbox", { name: "ID" }).click();
    await window.keyboard.press("Escape");
    await expect
      .poll(() => headerNames(window))
      .toEqual(["", "Title / Context", "Status", "Updated"]);
    await shot(window, "06-drawer-id-hidden-dark");
    // Closing the drawer brings back the full table's set.
    await window.keyboard.press("Escape");
    await expect(
      window.getByTestId("task-drawer-resize-handle"),
    ).not.toBeVisible();
    await expect
      .poll(() => headerNames(window))
      .toEqual(["", "ID", "Title / Context", "Assignees", "Status", "Updated"]);

    // Widths survive a reload.
    await dragHandle(window, "updated", -40);
    expect(await widthOf(header(window, "Updated"))).toBe(144);
    await window.reload();
    await openTasks(window);
    expect(await widthOf(header(window, "Updated"))).toBe(144);
    expect(await widthOf(header(window, "ID"))).toBe(112);

    // Light theme evidence.
    await window.evaluate(
      (n) => window.electronAPI.theme.setSelected(n),
      LIGHT_THEME,
    );
    await window.waitForTimeout(1_000);
    await window.mouse.move(1, 400);
    await shot(window, "07-table-light");
    await window.getByTestId("tasks-display-menu").click();
    await shot(window, "08-display-menu-light");
    await window.keyboard.press("Escape");
    await window
      .getByTestId("task-row")
      .nth(1)
      .getByText("by orrybaram")
      .click();
    await expect(window.getByTestId("task-drawer-resize-handle")).toBeVisible();
    await window.mouse.move(1, 400);
    await shot(window, "09-drawer-open-light");

    // Home's Up next keeps its fixed compact columns, whatever the Tasks table chose.
    await window.keyboard.press("Escape");
    await window.getByText("Dashboard", { exact: true }).first().click();
    await expect(
      window.getByRole("table", { name: "Up next tasks" }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await window.mouse.move(1, 400);
    await shot(window, "10-home-up-next-light");

    // A phone-width window shows full cards even with Status hidden on the desk table.
    await window.getByText("Tasks", { exact: true }).first().click();
    await header(window, "Updated").click({ button: "right" });
    await menu.getByRole("menuitemcheckbox", { name: "Status" }).click();
    await window.keyboard.press("Escape");
    await expect.poll(() => headerNames(window)).not.toContain("Status");
    await window.setViewportSize({ width: 400, height: 800 });
    await expect(window.locator(":root[data-layout='phone']")).toBeAttached({
      timeout: 10_000,
    });
    await expect(
      window.getByTestId("task-row").first().getByText("Open"),
    ).toBeVisible();
    await shot(window, "11-phone-cards-light");
  });
});
