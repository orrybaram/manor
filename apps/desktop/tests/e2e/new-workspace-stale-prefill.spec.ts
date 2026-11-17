import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";

/**
 * Starting a task opens New Workspace prefilled with its name and prompt.
 * Once that workspace is created, a plain ⌘⇧N opens a blank dialog — not
 * the last task's prompt again.
 *
 * A fake `gh` on PATH lists one canned issue for the Tasks view.
 */

const EVIDENCE = process.env.MANOR_E2E_EVIDENCE;
const TITLE = "Honor Global Privacy Control everywhere";

const ISSUES = [
  {
    number: 41,
    title: TITLE,
    url: "https://github.com/acme/app/issues/41",
    state: "OPEN",
    labels: [],
    assignees: [{ login: "tester" }],
    updatedAt: new Date().toISOString(),
    author: { login: "tester" },
    createdAt: "2026-09-01T10:00:00Z",
    closedAt: null,
    milestone: null,
    comments: [],
    stateReason: null,
    projectItems: [],
  },
];

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

const test = base.extend<{ app: ElectronApplication; window: Page }>({
  app: async ({ tempHome }, use) => {
    const projectPath = path.join(tempHome, "test-project");
    const seed = {
      projects: [
        {
          id: "proj-tasks",
          name: "manor",
          path: projectPath,
          defaultBranch: "main",
          workspaces: [
            { path: projectPath, branch: "main", isMain: true, name: null, linkedIssues: [] },
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
      fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(seed, null, 2));
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

async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(300);
  const file = EVIDENCE
    ? path.join(EVIDENCE, `${name}.png`)
    : test.info().outputPath(`${name}.png`);
  await window.getByTestId("new-workspace-dialog").screenshot({ path: file });
}

const dialog = (window: Page) => window.getByTestId("new-workspace-dialog");
const nameInput = (window: Page) => window.getByTestId("new-workspace-name-input");
const prompt = (window: Page) => window.getByTestId("new-workspace-agent-prompt");

test("⌘⇧N after creating a task's workspace opens a blank dialog", async ({ window }) => {
  await window.getByText("Tasks", { exact: true }).first().click({ timeout: 30_000 });
  const row = window.getByTestId("task-row").filter({ hasText: TITLE });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  await window
    .getByTestId("task-detail")
    .getByRole("button", { name: /^Start/ })
    .click({ timeout: 10_000 });

  await expect(dialog(window)).toBeVisible({ timeout: 10_000 });
  await expect(prompt(window)).toHaveValue(new RegExp(TITLE));
  await expect(nameInput(window)).not.toHaveValue("");
  await shot(window, "stale-prefill-1-task-start");

  await window.getByTestId("new-workspace-submit").click();
  await expect(dialog(window)).not.toBeVisible({ timeout: 20_000 });

  await window.keyboard.press("ControlOrMeta+Shift+n");
  await expect(dialog(window)).toBeVisible({ timeout: 5_000 });
  await expect(prompt(window)).toHaveValue("");
  await expect(nameInput(window)).toHaveValue("");
  await shot(window, "stale-prefill-2-blank-after");
});
