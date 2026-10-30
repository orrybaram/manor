import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_TRANSCRIPT, FAKE_CHAT_PROMPT, FAKE_CHAT_REPLY } from "./helpers/fake-agent";
import { readSession } from "./helpers/local-api";
import {
  APP_TARGET,
  SEED_REPO_URL,
  installRemoteStubs,
  onRemote,
  pollFor,
  remoteKind,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
} from "./helpers/remote-host";
import { awaitShellReady, runInTerminal } from "./helpers/terminal";
import type { PaneNode } from "../../src/lib/layout/pane-tree";
import type { LayoutEntry } from "../../src/lib/layout/protocol";
import type { Tab } from "../../src/lib/layout/workspace-layout";
import { workspaceKey } from "../../src/lib/workspace-key";

/**
 * Move to Host, end to end against a real sshd, with nothing stubbed:
 *
 * 1. A local project cloned from the box's seed (so both ends share an
 *    origin), two local workspaces on new branches, each one commit ahead.
 *    The first has a split tab (terminal cd'd into a subfolder + a file
 *    pane), a browser tab, and a tab running a fake Claude agent that
 *    writes a transcript.
 * 2. Dirty refusal: an untracked file blocks the move, listed, and nothing
 *    reaches the box.
 * 3. A move with Remove ticked (the default): push, set up on the box,
 *    create, layout, a fresh agent with the handoff prompt, the source
 *    removed, the window on the box's workspace.
 * 4. Keep: the second workspace moves with Remove unticked; both remain, and
 *    the box project's start script runs.
 * 5. Reuse: the kept workspace, one commit further on, moves again onto the
 *    box's worktree of its branch: the warning shows, the move reuses and
 *    fast-forwards it.
 *
 * Skipped unless MANOR_E2E_SSH=1 (see remote-host.spec.ts for the harness).
 * MANOR_SHOTS=<dir> saves a screenshot per step; MANOR_E2E_VIDEO=1 records.
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");
test.describe.configure({ mode: "serial" });

const STEP = 60_000;
/** A first connect to the Linux box compiles node-pty. */
const CONNECT_TIMEOUT = remoteKind() === "docker" ? 15 * 60_000 : 5 * 60_000;
/** A whole move: push, a clone on the box, a worktree, the layout, an agent. */
const MOVE_TIMEOUT = 6 * STEP;

const BRANCH = "move-me";
const KEEP_BRANCH = "move-keep";
const BROWSER_URL = "https://example.com/manor-move-e2e";
const FILE_PATH = "docs/notes.md";
const SUBFOLDER = "docs";
const AGENT_TITLE = "move-e2e-agent";
/** The agent command, the same string on both hosts: a wrapper under each one's $HOME. */
const AGENT_COMMAND = "$HOME/.manor-e2e/bin/move-agent";
/** Where the box's wrapper writes the prompt it was started with. */
const REMOTE_PROMPT_LOG = "$HOME/.manor-e2e/move-agent-prompt.txt";
/** Where the box project's start script logs the tree it ran in. */
const REMOTE_START_LOG = "$HOME/.manor-e2e/start-script.log";
const START_SCRIPT = `mkdir -p "$HOME/.manor-e2e" && pwd >> "${REMOTE_START_LOG}"`;

let shot = 0;

async function snap(window: Page, name: string): Promise<void> {
  const dir = process.env.MANOR_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  shot += 1;
  await window.screenshot({ path: path.join(dir, `${String(shot).padStart(2, "0")}-${name}.png`) });
}

/**
 * Catppuccin Latte's colours over the page's own, or back to them. Applied
 * as inline variables, as move-workspace-to-host.spec.ts does, so it is
 * instant: a mid-move screenshot can't wait for a theme to load.
 */
async function useTheme(window: Page, theme: "dark" | "light"): Promise<void> {
  await window.evaluate((t) => {
    const root = document.documentElement;
    const w = window as unknown as { __savedStyle?: string | null };
    if (t === "dark") {
      if (w.__savedStyle !== undefined) {
        if (w.__savedStyle === null) root.removeAttribute("style");
        else root.setAttribute("style", w.__savedStyle);
        delete w.__savedStyle;
      }
      return;
    }
    if (w.__savedStyle === undefined) w.__savedStyle = root.getAttribute("style");
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
      "--blue": "#1e66f5",
      "--green": "#40a02b",
      "--red": "#d20f39",
      "--yellow": "#df8e1d",
    };
    for (const [k, v] of Object.entries(latte)) root.style.setProperty(k, v);
    root.style.colorScheme = "light";
  }, theme);
  await window.waitForTimeout(150);
}

/** Both themes, dark first, ending on dark. */
async function snapBoth(window: Page, name: string): Promise<void> {
  await snap(window, `${name}-dark`);
  await useTheme(window, "light");
  await snap(window, `${name}-light`);
  await useTheme(window, "dark");
}

// ── The app's state, through its own bridge ──

interface WorkspaceRow {
  path: string;
  branch: string;
  isMain: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  hostId: string;
  path: string;
  workspaces: WorkspaceRow[];
}

async function projects(window: Page): Promise<ProjectRow[]> {
  return (await window.evaluate(() => window.electronAPI.projects.getAll())) as unknown as ProjectRow[];
}

async function layouts(window: Page): Promise<Record<string, LayoutEntry>> {
  return (await window.evaluate(() => window.electronAPI.layout.getAll())) as unknown as Record<
    string,
    LayoutEntry
  >;
}

async function apply(window: Page, key: string, command: unknown): Promise<void> {
  const result = (await window.evaluate(
    ([k, c]) => window.electronAPI.layout.apply(k as string, c as never),
    [key, command] as const,
  )) as unknown as { error?: string };
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(`layout command refused: ${result.error}`);
  }
}

/** Every tab of a layout, in panel-tree order. */
function tabsOf(entry: LayoutEntry): Tab[] {
  const order: string[] = [];
  const walk = (node: LayoutEntry["layout"]["panelTree"]): void => {
    if (node.type === "leaf") order.push(node.panelId);
    else {
      walk(node.first);
      walk(node.second);
    }
  };
  walk(entry.layout.panelTree);
  return order.flatMap((id) => entry.layout.panels[id]?.tabs ?? []);
}

function leaves(node: PaneNode): Extract<PaneNode, { type: "leaf" }>[] {
  return node.type === "leaf" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

/** What a move must carry across: each tab's title and shape. */
interface LayoutShape {
  title: string;
  split: string | null;
  leaves: Array<{ contentType: string; filePath?: string; url?: string }>;
}

function shapeOf(entry: LayoutEntry): LayoutShape[] {
  return tabsOf(entry).map((tab) => ({
    title: tab.title,
    split: tab.rootNode.type === "split" ? tab.rootNode.direction : null,
    leaves: leaves(tab.rootNode).map((l) => ({
      contentType: l.contentType ?? "terminal",
      ...(l.filePath ? { filePath: l.filePath } : {}),
      ...(l.url ? { url: l.url } : {}),
    })),
  }));
}

/**
 * `key`'s layout once it has `shape`, failing with what it has instead. A
 * new workspace may briefly hold a default tab, or a Setup tab running its
 * script, so it is polled rather than read once.
 */
async function settledLayout(window: Page, key: string, shape: LayoutShape[]): Promise<LayoutEntry> {
  let last: LayoutShape[] | null = null;
  try {
    return await pollFor(
      `${key}'s layout`,
      async () => {
        const entry = (await layouts(window))[key];
        last = entry ? shapeOf(entry) : null;
        return entry && JSON.stringify(last) === JSON.stringify(shape) ? entry : null;
      },
      STEP,
      500,
    );
  } catch {
    expect(last, `${key}'s layout`).toEqual(shape);
    throw new Error("unreachable");
  }
}

const row = (window: Page, wsPath: string) =>
  window.locator(`[data-testid="workspace-item"][data-workspace-path="${wsPath}"]`);
const dialog = (window: Page) => window.getByTestId("move-to-host-dialog");

async function openMoveDialog(window: Page, wsPath: string, hostId: string): Promise<void> {
  await row(window, wsPath).click({ button: "right" });
  await window.getByTestId("workspace-move-to-host").hover();
  const item = window.getByTestId(`workspace-move-to-host-${hostId}`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(window.getByTestId("move-to-host-confirm")).toBeVisible();
  await expect(window.getByTestId("move-to-host-confirm")).not.toHaveAttribute("data-preflight", "loading", {
    timeout: STEP,
  });
}

async function setRemoveSource(window: Page, remove: boolean): Promise<void> {
  const box = window.getByTestId("move-to-host-remove-source");
  if (((await box.getAttribute("data-state")) === "checked") !== remove) await box.click();
  await expect(box).toHaveAttribute("data-state", remove ? "checked" : "unchecked");
}

/** The step labels on screen (a fading label and its successor can overlap). */
async function stepLabels(window: Page): Promise<string> {
  return (await window.getByTestId("move-to-host-step").allTextContents()).join(" | ");
}

/** Wait for the dialog to close on success; on a failure, throw with its details. */
async function awaitMoveOutcome(window: Page, what: string): Promise<void> {
  const outcome = await pollFor(
    what,
    async () => {
      if ((await dialog(window).count()) === 0) return "closed";
      return (await dialog(window).getAttribute("data-phase")) === "failed" ? "failed" : null;
    },
    MOVE_TIMEOUT,
    500,
  );
  if (outcome === "failed") {
    await snap(window, `${what.replace(/\W+/g, "-")}-failed`);
    const summary = await window.getByTestId("move-to-host-failed").textContent();
    await window.getByTestId("move-to-host-show-details").click();
    const details = await window.getByTestId("move-to-host-error").textContent();
    throw new Error(`${what} failed: ${summary}\n${details}`);
  }
}

// ── Git on both ends ──

function git(cwd: string, args: string): string {
  return execSync(`git -c user.email=e2e@manor.local -c "user.name=Manor E2E" ${args}`, {
    cwd,
    encoding: "utf-8",
  }).trim();
}

/** A branch's head in the box's bare origin, or null when it has none. */
function originHead(branch: string): string | null {
  const res = onRemote(`git --git-dir "$HOME/manor-e2e-seed.git" rev-parse --verify -q refs/heads/${branch}`, {
    allowFailure: true,
  });
  return res.code === 0 ? res.stdout.trim() : null;
}

function remoteHead(dir: string): string {
  return onRemote(`git -C '${dir}' rev-parse HEAD`).stdout.trim();
}

test.beforeAll(() => {
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
  // The agent the moved pane starts on the box: it notes its prompt, then
  // is the harness's stub agent (hooks through the box's real hook script).
  onRemote(
    `cat > "$HOME/.manor-e2e/bin/move-agent" && chmod 755 "$HOME/.manor-e2e/bin/move-agent"; ` +
      `rm -f "${REMOTE_PROMPT_LOG}" "${REMOTE_START_LOG}"`,
    {
      stdin: [
        "#!/bin/sh",
        'mkdir -p "$HOME/.manor-e2e"',
        `printf '%s' "$*" > "${REMOTE_PROMPT_LOG}"`,
        'exec "$HOME/.manor-e2e/bin/manor-e2e-agent" "$@"',
        "",
      ].join("\n"),
    },
  );
});

test("move workspace to host over ssh: dirty refusal, move, keep, reuse", async ({
  window,
  tempHome,
  request,
}) => {
  test.setTimeout(CONNECT_TIMEOUT + 30 * STEP);

  const sshConfig = process.env.MANOR_E2E_SSH_CONFIG!;
  const sshCommand = `ssh -F '${sshConfig}'`;
  const local = path.join(tempHome, "code", "seed");
  let hostId = "";
  let projectId = "";
  let wsA = "";
  let wsB = "";
  let agentPane = "";
  let codeTerminalPane = "";
  let cwdObserved = false;

  await test.step("1. a local project and two workspaces, one with tabs and an agent", async () => {
    // Cloned from the box's own bare origin over the side channel, so both
    // ends share one history. The stored URL is the seed URL, which the box
    // rewrites to that bare repo (`seedRemoteRepo`); here the same rewrite
    // goes over ssh, for the move's push and the worktree's fetch.
    execSync(
      [
        `mkdir -p '${path.dirname(local)}'`,
        `GIT_SSH_COMMAND="${sshCommand}" git clone -q manor-e2e-direct:manor-e2e-seed.git '${local}'`,
        `git -C '${local}' config core.sshCommand "${sshCommand}"`,
        `git -C '${local}' config url.manor-e2e-direct:manor-e2e-seed.git.insteadOf ${SEED_REPO_URL}`,
        `git -C '${local}' remote set-url origin ${SEED_REPO_URL}`,
      ].join(" && "),
    );
    // The same agent command runs on both hosts; here, the local fake.
    const localBin = path.join(tempHome, ".manor-e2e", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "move-agent"), `#!/bin/sh\nexec "${FAKE_AGENT}" "$@"\n`, {
      mode: 0o755,
    });

    const { hostId: id } = await window.evaluate((t) => window.electronAPI.hosts.add(t), APP_TARGET);
    hostId = id;
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
      CONNECT_TIMEOUT,
      500,
    );

    const added = (await window.evaluate((p) => window.electronAPI.projects.add("seed", p), local)) as unknown as {
      id: string;
    };
    projectId = added.id;
    // Before the move links a box project to it: the group starts from this
    // project's settings, so the box's agent is the wrapper too.
    await window.evaluate(
      ([pid, cmd]) => window.electronAPI.projects.update(pid, { agentCommand: cmd }),
      [projectId, AGENT_COMMAND] as const,
    );
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.getByTestId("project-header").filter({ hasText: "seed" })).toBeVisible({
      timeout: 20_000,
    });

    // Two workspaces on new branches, each one commit ahead of origin.
    for (const branch of [BRANCH, KEEP_BRANCH]) {
      await window.evaluate(
        ([pid, b]) => window.electronAPI.projects.createWorktree(pid, b, { branch: b }),
        [projectId, branch] as const,
      );
    }
    const mine = (await projects(window)).find((p) => p.id === projectId)!;
    wsA = mine.workspaces.find((w) => w.branch === BRANCH)!.path;
    wsB = mine.workspaces.find((w) => w.branch === KEEP_BRANCH)!.path;
    fs.mkdirSync(path.join(wsA, SUBFOLDER), { recursive: true });
    fs.writeFileSync(path.join(wsA, FILE_PATH), "# Notes\n\nWritten before the move.\n");
    git(wsA, "add -A");
    git(wsA, 'commit -q -m "notes before the move"');
    git(wsB, 'commit -q --allow-empty -m "kept work"');
    expect(originHead(BRANCH)).toBeNull();

    // The move carries this onto the project it sets up on the box (step 3).
    await window.evaluate(
      ([pid, s]) => window.electronAPI.projects.update(pid, { worktreeStartScript: s }),
      [projectId, START_SCRIPT] as const,
    );

    // A's layout: Code (terminal | file), Web (browser), Agent.
    await row(window, wsA).click();
    await expect(row(window, wsA)).toHaveAttribute("aria-current", "true");
    const id8 = () => Math.random().toString(36).slice(2, 10);
    codeTerminalPane = `pane-e2e-term-${id8()}`;
    agentPane = `pane-e2e-agent-${id8()}`;
    await apply(window, wsA, {
      type: "new-tab",
      select: false,
      tab: {
        id: `tab-e2e-code-${id8()}`,
        title: "Code",
        rootNode: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", paneId: codeTerminalPane },
          second: { type: "leaf", paneId: `pane-e2e-file-${id8()}`, contentType: "file", filePath: FILE_PATH },
        },
      },
    });
    await apply(window, wsA, {
      type: "new-tab",
      select: false,
      tab: {
        id: `tab-e2e-web-${id8()}`,
        title: "Web",
        rootNode: { type: "leaf", paneId: `pane-e2e-web-${id8()}`, contentType: "browser", url: BROWSER_URL },
      },
    });
    await apply(window, wsA, {
      type: "new-tab",
      select: true,
      tab: { id: `tab-e2e-agent-${id8()}`, title: "Agent", rootNode: { type: "leaf", paneId: agentPane } },
    });
    // Whatever the new workspace opened with goes, so the layout is exactly
    // these three. Polled: a renderer may open its default tab late.
    await window.waitForTimeout(1_000);
    await pollFor(
      "A's layout to be just its three tabs",
      async () => {
        const tabs = tabsOf((await layouts(window))[wsA]);
        const extra = tabs.filter((t) => !t.id.startsWith("tab-e2e-"));
        for (const tab of extra) await apply(window, wsA, { type: "close-tab", tabId: tab.id });
        return extra.length === 0 && tabs.length === 3 ? true : null;
      },
      20_000,
      1_000,
    );

    // The agent: Claude-kind hooks and a transcript with one exchange.
    // A tab bar shows each pane's live name, not the stored title: find tabs by id.
    const tabIdOf = async (title: string) => tabsOf((await layouts(window))[wsA]).find((t) => t.title === title)!.id;
    const tabButton = async (title: string) => window.locator(`[data-testid="tab"][data-tab-id="${await tabIdOf(title)}"]`);
    await (await tabButton("Agent")).click();
    await expect(window.locator(`[data-testid="workspace-pane"][data-pane-id="${agentPane}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await awaitShellReady(window, tempHome, agentPane);
    const chatDir = path.join(tempHome, "move-chat");
    // The transcript sits in Claude's own store under the app's HOME: the
    // preview reader only opens a path inside that kind's store.
    const transcriptDir = path.join(tempHome, ".claude", "projects", "move-e2e");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(transcriptDir, { recursive: true });
    await runInTerminal(
      window,
      `"${FAKE_AGENT_TRANSCRIPT}" "${path.join(transcriptDir, "0b6f2c1e-move-e2e.jsonl")}" "${path.join(chatDir, "input.log")}" ${AGENT_TITLE}`,
    );
    await pollFor(
      "the local agent recorded on its pane",
      async () => ((await layouts(window))[wsA]?.paneSessions[agentPane]?.lastAgentStatus?.kind ? true : null),
      STEP,
      500,
    );

    // The Code tab's terminal, in the subfolder.
    await (await tabButton("Code")).click();
    await expect(window.locator(`[data-testid="workspace-pane"][data-pane-id="${codeTerminalPane}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await awaitShellReady(window, tempHome, codeTerminalPane);
    await runInTerminal(window, `cd ${SUBFOLDER}`);
    // The cwd is what the shell reports; a shell that reports none moves to the root.
    cwdObserved = await pollFor(
      "the subfolder terminal's cwd",
      async () =>
        (await layouts(window))[wsA]?.paneSessions[codeTerminalPane]?.lastCwd?.endsWith(`/${SUBFOLDER}`)
          ? true
          : null,
      15_000,
      500,
    ).catch(() => false);
    expect.soft(cwdObserved, "the source terminal's cwd was never reported").toBe(true);

    // B's layout: one terminal tab, kept by step 4.
    await apply(window, wsB, {
      type: "new-tab",
      select: true,
      tab: { id: `tab-e2e-keep-${id8()}`, title: "Keep", rootNode: { type: "leaf", paneId: `pane-e2e-keep-${id8()}` } },
    });
    await snap(window, "before-move");
  });

  await test.step("2. dirty refusal touches nothing", async () => {
    fs.writeFileSync(path.join(wsA, "scratch.txt"), "not committed\n");
    await openMoveDialog(window, wsA, hostId);
    const dirty = window.getByTestId("move-to-host-dirty");
    await expect(dirty).toContainText("Commit or discard 1 changed file first.");
    await expect(dirty).toContainText("scratch.txt");
    await expect(window.getByTestId("move-to-host-move")).toBeDisabled();
    await snapBoth(window, "dirty");
    await dialog(window).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(window)).toHaveCount(0);
    fs.rmSync(path.join(wsA, "scratch.txt"));

    // Nothing reached the box: no push, no project, no clone.
    expect(originHead(BRANCH)).toBeNull();
    expect((await projects(window)).filter((p) => p.hostId === hostId)).toEqual([]);
    onRemote('test ! -e "$HOME/code/seed"');
    // And nothing changed here.
    expect(fs.existsSync(wsA)).toBe(true);
    expect((await projects(window)).find((p) => p.id === projectId)?.workspaces.map((w) => w.path)).toContain(wsA);
  });

  await test.step("3. move with Remove ticked", async () => {
    const localHead = git(wsA, "rev-parse HEAD");
    const sourceEntry = (await layouts(window))[wsA];
    const sourceShape = shapeOf(sourceEntry);
    expect(sourceShape.map((t) => t.title)).toEqual(["Code", "Web", "Agent"]);

    await openMoveDialog(window, wsA, hostId);
    const confirm = window.getByTestId("move-to-host-confirm");
    await expect(confirm).toContainText(`Move “${BRANCH}” to ${APP_TARGET}?`);
    await expect(confirm).toContainText(
      `Your tabs come back on ${APP_TARGET}, and agents pick up where they left off.`,
    );
    await expect(window.getByTestId("move-to-host-remove-source")).toHaveAttribute("data-state", "checked");
    await expect(window.getByTestId("move-to-host-reuse")).toHaveCount(0);
    await expect(window.getByTestId("move-to-host-move")).toBeEnabled();
    await snapBoth(window, "confirm");

    await window.getByTestId("move-to-host-move").click();
    await expect(window.getByTestId("move-to-host-moving")).toBeVisible();
    // Mid-move: once the label has moved on from its first step.
    const first = await stepLabels(window);
    await pollFor(
      "the step label to change",
      async () => {
        if ((await dialog(window).count()) === 0) throw new Error("the move ended before a second step showed");
        const now = await stepLabels(window);
        return now && now !== first ? now : null;
      },
      MOVE_TIMEOUT,
      100,
    );
    await snapBoth(window, "mid-move");
    await awaitMoveOutcome(window, "the move");

    // Pushed: origin has the branch at the local commit.
    expect(originHead(BRANCH)).toBe(localHead);

    // Set up on the box, with a worktree on the branch at that commit.
    const boxProject = (await projects(window)).find((p) => p.hostId === hostId);
    expect(boxProject, "a project on the box").toBeTruthy();
    onRemote(`test -d '${boxProject!.path}/.git'`);
    const target = boxProject!.workspaces.find((w) => w.branch === BRANCH);
    expect(target, `a ${BRANCH} workspace on the box`).toBeTruthy();
    const targetPath = target!.path;
    expect(remoteHead(targetPath)).toBe(localHead);
    onRemote(`test -f '${targetPath}/${FILE_PATH}'`);

    // The start script: the move carries the source's onto the project it set up.
    const startLog = onRemote(`cat "${REMOTE_START_LOG}" 2>/dev/null; true`).stdout;
    expect(startLog, "the start script ran in the new worktree").toContain(targetPath);

    // The window is on the box's workspace.
    await expect(row(window, targetPath)).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
    await snap(window, "after-move");

    // The layout: the same tabs, titles, split, file and url.
    const targetKey = workspaceKey(hostId, targetPath);
    const targetEntry = await settledLayout(window, targetKey, sourceShape);

    // The subfolder terminal starts in the same subfolder of the new root.
    const codeTab = tabsOf(targetEntry).find((t) => t.title === "Code")!;
    const targetTerminal = leaves(codeTab.rootNode).find((l) => (l.contentType ?? "terminal") === "terminal")!;
    await window.locator(`[data-testid="tab"][data-tab-id="${codeTab.id}"]`).click();
    await expect(
      window.locator(`[data-testid="workspace-pane"][data-pane-id="${targetTerminal.paneId}"]`),
    ).toBeVisible({ timeout: 30_000 });
    const expectedCwd = cwdObserved ? `${targetPath}/${SUBFOLDER}` : targetPath;
    await pollFor(
      "the moved terminal's cwd",
      async () => {
        await runInTerminal(window, "echo CWD=$(pwd)");
        await window.waitForTimeout(1_000);
        return (await readSession(request, tempHome, targetTerminal.paneId)).includes(`CWD=${expectedCwd}`)
          ? true
          : null;
      },
      STEP,
      2_000,
    );

    // Removed here; the branch stays.
    expect(fs.existsSync(wsA)).toBe(false);
    expect(git(local, `rev-parse --verify -q refs/heads/${BRANCH}`)).toBe(localHead);
    expect((await projects(window)).find((p) => p.id === projectId)?.workspaces.map((w) => w.path)).not.toContain(
      wsA,
    );

    // A fresh agent on the box, started with the handoff.
    const agentTab = tabsOf(targetEntry).find((t) => t.title === "Agent")!;
    const newAgentPane = leaves(agentTab.rootNode)[0].paneId;
    expect(newAgentPane).not.toBe(agentPane);
    const prompt = await pollFor(
      "the box's agent to start with its prompt",
      () => {
        const out = onRemote(`cat "${REMOTE_PROMPT_LOG}" 2>/dev/null; true`).stdout;
        return out.trim() ? out : null;
      },
      2 * STEP,
      1_000,
    );
    expect(prompt).toContain(`Continuing work moved from this machine to ${APP_TARGET}.`);
    expect(prompt).toContain(`All committed work is on branch ${BRANCH}.`);
    // The Session's title and turns, read from the local transcript.
    expect(prompt).toContain(`Session: ${AGENT_TITLE}`);
    expect(prompt).toContain(FAKE_CHAT_PROMPT);
    expect(prompt).toContain(FAKE_CHAT_REPLY);
    // The stub prints what it was given in its pane.
    await pollFor(
      "the box's agent pane to show its prompt",
      async () =>
        (await readSession(request, tempHome, newAgentPane)).includes("manor-e2e-agent prompt: Continuing work moved from")
          ? true
          : null,
      STEP,
      1_000,
    ).catch((err: unknown) => {
      expect.soft(String(err), "the new agent pane's scrollback").toBe("");
    });
  });

  await test.step("4. Keep: Remove unticked", async () => {
    const boxProject = (await projects(window)).find((p) => p.hostId === hostId)!;
    // The box project's own start script, which this move runs.
    await window.evaluate(
      ([pid, s]) => window.electronAPI.projects.update(pid, { worktreeStartScript: s }),
      [boxProject.id, START_SCRIPT] as const,
    );
    const localHead = git(wsB, "rev-parse HEAD");
    const keepShape = shapeOf((await layouts(window))[wsB]);

    await openMoveDialog(window, wsB, hostId);
    await setRemoveSource(window, false);
    await snap(window, "keep-confirm");
    await window.getByTestId("move-to-host-move").click();
    await awaitMoveOutcome(window, "the keep move");

    const all = await projects(window);
    const target = all.find((p) => p.hostId === hostId)!.workspaces.find((w) => w.branch === KEEP_BRANCH);
    expect(target, `a ${KEEP_BRANCH} workspace on the box`).toBeTruthy();
    expect(remoteHead(target!.path)).toBe(localHead);
    expect(onRemote(`cat "${REMOTE_START_LOG}"`).stdout).toContain(target!.path);
    await expect(row(window, target!.path)).toHaveAttribute("aria-current", "true", { timeout: 20_000 });

    // Both remain: the source, its tree and its layout.
    expect(all.find((p) => p.id === projectId)!.workspaces.map((w) => w.path)).toContain(wsB);
    expect(fs.existsSync(wsB)).toBe(true);
    await expect(row(window, wsB)).toBeVisible();
    expect(shapeOf((await layouts(window))[wsB])).toEqual(keepShape);
    // A Setup tab closes as its script exits, so the target's layout settles.
    await settledLayout(window, workspaceKey(hostId, target!.path), keepShape);
    await snap(window, "after-keep");
  });

  await test.step("5. Reuse: the box already has the branch", async () => {
    const boxBefore = (await projects(window))
      .find((p) => p.hostId === hostId)!
      .workspaces.find((w) => w.branch === KEEP_BRANCH)!.path;
    // One more commit here, so the reused tree must fast-forward.
    git(wsB, 'commit -q --allow-empty -m "more kept work"');
    const localHead = git(wsB, "rev-parse HEAD");
    expect(remoteHead(boxBefore)).not.toBe(localHead);

    await openMoveDialog(window, wsB, hostId);
    await expect(window.getByTestId("move-to-host-reuse")).toHaveText(
      `${APP_TARGET} already has this branch checked out. The move will use it.`,
    );
    await setRemoveSource(window, true);
    await snapBoth(window, "reuse-confirm");
    await window.getByTestId("move-to-host-move").click();
    await awaitMoveOutcome(window, "the reuse move");

    const box = (await projects(window)).find((p) => p.hostId === hostId)!;
    const onBranch = box.workspaces.filter((w) => w.branch === KEEP_BRANCH);
    expect(onBranch.map((w) => w.path)).toEqual([boxBefore]);
    expect(remoteHead(boxBefore)).toBe(localHead);
    expect(originHead(KEEP_BRANCH)).toBe(localHead);
    await expect(row(window, boxBefore)).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
    // The source went this time; its branch stays.
    expect(fs.existsSync(wsB)).toBe(false);
    expect(git(local, `rev-parse --verify -q refs/heads/${KEEP_BRANCH}`)).toBe(localHead);
    await snap(window, "after-reuse");
  });
});
