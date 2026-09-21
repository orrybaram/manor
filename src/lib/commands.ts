/**
 * The command table (ADR-182 D10): every command the keyboard, the native
 * menu and the command palette can run, each described once.
 *
 * A command used to live in about seven hand-synced places — the keybinding
 * registry, three id lists in `menu-commands.ts`, two handler maps and the
 * palette's own items — and the copies drifted (the palette's Close Tab
 * skipped the confirmation the keyboard's shows). Now:
 *
 * - `DEFAULT_KEYBINDINGS` (`keybinding-defs.ts`) is every entry with a
 *   `defaultCombo` key, in table order — which is also match order;
 * - `SHARED_WINDOW_COMMANDS` / `MAIN_WINDOW_KEYBINDINGS`
 *   (`menu-commands.ts`) are the runnable entries by `scope`;
 * - the handler maps behind the keyboard and the menu are `run` over this
 *   table (`commandHandlers`), and the palette's static items dispatch into
 *   those maps;
 * - web availability is decided here, once, from `native`.
 *
 * Like `keybinding-defs.ts` this module must stay free of the DOM and of
 * renderer imports (its runtime imports are the leaves `home-path.ts` and
 * `bridge/unavailable.ts`): Electron main loads it, through
 * `keybinding-defs.ts` and `menu-commands.ts`, to build the menu and route
 * its clicks. That is why a `run` never reaches for a store itself — it acts
 * through the `CommandContext` the renderer hands it, whose types are
 * declared here as the structural slice the table needs.
 */

import type { KeyCombo, KeybindingCategory } from "./keybinding-defs";
import {
  UNAVAILABLE_NAMESPACES,
  type UnavailableNamespace,
} from "../bridge/unavailable";
import type { UiRequest } from "../utils/ui-request";
import { HOME_PATH } from "./home-path";

// ── The context a command runs against ────────────────────────────────────

type SplitDirection = "horizontal" | "vertical";

/** Pane content a command can split with or convert to. */
export type CommandPaneKind = "terminal" | "browser" | "diff" | "agent";

/** The slice of `useAppStore.getState()` the table calls. */
export interface AppCommandActions {
  addTab(): void;
  addBrowserTab(url: string): void;
  splitPane(direction: SplitDirection): void;
  requestClosePane(): void;
  reopenClosedPane(): void;
  requestCloseTab(tabId: string): void;
  selectNextTab(): void;
  selectPrevTab(): void;
  focusNextPane(): void;
  focusPrevPane(): void;
  splitPanel(direction: SplitDirection): void;
  focusNextPanel(): void;
  focusPrevPanel(): void;
  closePanel(panelId: string): void;
  selectTabByGlobalIndex(index: number): void;
  openDiffInNewPanel(): void;
  openOrFocusDiff(): void;
  setActiveWorkspace(path: string): void;
  togglePinTab(tabId: string): void;
}

/** The focused browser pane's imperative handle (`BrowserPaneRef`). */
export interface BrowserCommandTarget {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  reload(): void;
  goBack(): void;
  goForward(): void;
}

/** The active surface, resolved back to its owning project and workspace. */
export interface ActiveSurface {
  path: string | null;
  project: {
    id: string;
    worktreeStartScript?: string | null;
  } | null;
  workspace: { branch?: string | null } | null;
}

/** What a command meaningful in any window — popouts included — may touch. */
export interface SharedCommandContext {
  /** `useAppStore.getState()`, read fresh on every call. */
  app(): AppCommandActions;
  active(): ActiveSurface;
  /** The active panel, and the selected tab in it. */
  activePanelId(): string | null;
  activeTabId(): string | null;
  focusedPaneId(): string | null;
  copyToClipboard(text: string, label: string): void;
  startNewAgent(): void;
  /** Move the active panel's selected tab to the next panel, wrapping. */
  moveTabToNextPanel(): void;
  focusedBrowser(): BrowserCommandTarget | undefined;
  /** The focused pane's id when that pane is a browser. */
  focusedBrowserPaneId(): string | undefined;
  focusBrowserUrlBar(paneId: string): void;
  requestUi(request: UiRequest): void;
  cycleRegion(delta: 1 | -1): void;
  /** Focus a chrome region now; false when it has nothing to focus. */
  focusRegion(region: "sidebar" | "tabbar"): boolean;
  diffOpensInNewPanel(): boolean;
}

/**
 * The `App`-owned chrome a primary-window command may need — React state only
 * `App` can drive. The literal unions are the only values the table passes;
 * `MenuChrome` (`menu-handlers.ts`) takes the wider real types.
 */
export interface CommandChrome {
  openSettings(page?: "keybindings" | "remote"): void;
  togglePalette(): void;
  openPaletteView(
    view: "processes" | "stats" | "linear-all" | "github-all",
  ): void;
  openNewWorkspace(): void;
  addProject(): void;
  openFeedback(): void;
  openAgents(): void;
  openProjectSettings(projectId: string): void;
  resumeAgent(agentId: string): void;
  showGhosts(): void;
}

/** Everything a primary-window command may touch. */
export interface CommandContext extends SharedCommandContext {
  chrome: CommandChrome;
  toggleSidebar(): void;
  /** The sidebar owns several flows; a hidden one would swallow them. */
  ensureSidebarVisible(): void;
  focusRegionWhenReady(region: "sidebar"): void;
  navigateBack(): void;
  navigateForward(): void;
  switchToWorkspace(path: string): void;
  stepWorkspace(delta: 1 | -1): void;
  hideWorkspace(projectId: string, path: string): void;
  /** Into `folderId`, or out of the current folder when null. */
  moveActiveWorkspaceToFolder(folderId: string | null): void;
  /** Whether the active (or selected) project is linked to a Linear team. */
  activeProjectLinkedToLinear(): boolean;
  runSetupScript(path: string, script: string): void;
  /** The launch command for a new agent on `path`. */
  agentCommand(path: string | null): string;
  splitFocusedPaneWith(kind?: CommandPaneKind, paneCommand?: string): void;
  convertFocusedPaneTo(kind: CommandPaneKind): void;
  movePaneToNewWindow(paneId: string): void;
  detachTab(tabId: string): void;
  openInEditor(path: string): void;
  revealInFinder(path: string): void;
  openExternal(url: string): void;
  closeWindow(): void;
}

/** Menu commands carry optional args (a workspace path, a folder id, …). */
export type CommandArgs = Record<string, unknown> | undefined;

// ── The table's shape ─────────────────────────────────────────────────────

interface CommandMeta {
  id: string;
  label: string;
  category: KeybindingCategory;
  /**
   * Present (even as `null`) for a command the user can bind: it is listed in
   * `DEFAULT_KEYBINDINGS` and Settings › Keybindings. `null` is bindable with
   * no shortcut of its own (ADR-175) — `open-notifications`, so far.
   */
  defaultCombo?: KeyCombo | null;
  /**
   * The `src/bridge/unavailable.ts` namespace this command's only
   * implementation reaches. Such a command does nothing on the web app, so
   * it is left out of the web's handler maps and palette. Typed off
   * `UNAVAILABLE_NAMESPACES`, so a namespace that learns to work in a browser
   * stops type-checking here instead of silently hiding its commands.
   */
  native?: UnavailableNamespace;
}

/**
 * - `any`: meaningful in any window. A detached window runs it itself, and
 *   main routes its menu clicks to the focused window.
 * - `primary`: needs the primary window's chrome. A popout forwards a bound
 *   one to the primary (`MAIN_WINDOW_KEYBINDINGS`); main routes its menu
 *   clicks there.
 *
 * A shared command's `run` sees only `SharedCommandContext`, so it cannot
 * reach chrome a popout doesn't have. A command with no `run` is serviced
 * somewhere deeper (the focused terminal handles `terminal-search`).
 */
export type CommandDef = CommandMeta &
  (
    | {
        scope: "any";
        run?: (ctx: SharedCommandContext, args?: CommandArgs) => void;
      }
    | {
        scope: "primary";
        run: (ctx: CommandContext, args?: CommandArgs) => void;
      }
  );

function metaCombo(
  key: string,
  shift = false,
  alt = false,
  ctrl = false,
): KeyCombo {
  return { key, meta: true, ctrl, shift, alt };
}

/** A combo without ⌘ — only function keys may be bound this way (ADR-175). */
function plainCombo(key: string, shift = false): KeyCombo {
  return { key, meta: false, ctrl: false, shift, alt: false };
}

/** A string arg, or null when the caller sent nothing usable. */
function stringArg(args: CommandArgs, key: string): string | null {
  const value = args?.[key];
  return typeof value === "string" ? value : null;
}

/** URLs opened by the Help menu. */
export const EXTERNAL_LINKS = {
  docs: "https://github.com/orrybaram/manor#readme",
  releaseNotes: "https://github.com/orrybaram/manor/blob/main/CHANGELOG.md",
  newIssue: "https://github.com/orrybaram/manor/issues/new",
} as const;

// ── The table ─────────────────────────────────────────────────────────────

/**
 * Every command. The bindable ones come first, in registry order: that order
 * is the order a combo's commands are tried in (`commandsForCombo`), so e.g.
 * `prev-pane` beats `browser-back` on ⌘[ outside a browser.
 */
export const COMMANDS: readonly CommandDef[] = [
  // ── Bindable ────────────────────────────────────────────────────────────
  {
    id: "new-tab",
    label: "New Tab",
    category: "workspace",
    defaultCombo: metaCombo("t"),
    scope: "any",
    run: (ctx) => ctx.app().addTab(),
  },
  {
    id: "close-pane",
    label: "Close Pane",
    category: "terminal",
    defaultCombo: metaCombo("w"),
    scope: "any",
    run: (ctx) => ctx.app().requestClosePane(),
  },
  {
    id: "close-tab",
    label: "Close Tab",
    category: "workspace",
    defaultCombo: metaCombo("w", true),
    scope: "any",
    run: (ctx) => {
      const tabId = ctx.activeTabId();
      if (tabId) ctx.app().requestCloseTab(tabId);
    },
  },
  {
    id: "split-h",
    label: "Split Horizontal",
    category: "terminal",
    defaultCombo: metaCombo("d"),
    scope: "any",
    run: (ctx) => ctx.app().splitPane("horizontal"),
  },
  {
    id: "split-v",
    label: "Split Vertical",
    category: "terminal",
    defaultCombo: metaCombo("d", true),
    scope: "any",
    run: (ctx) => ctx.app().splitPane("vertical"),
  },
  {
    id: "next-tab",
    label: "Next Tab",
    category: "workspace",
    defaultCombo: metaCombo("]", true),
    scope: "any",
    run: (ctx) => ctx.app().selectNextTab(),
  },
  {
    id: "prev-tab",
    label: "Previous Tab",
    category: "workspace",
    defaultCombo: metaCombo("[", true),
    scope: "any",
    run: (ctx) => ctx.app().selectPrevTab(),
  },
  {
    id: "next-pane",
    label: "Next Pane",
    category: "terminal",
    defaultCombo: metaCombo("]"),
    scope: "any",
    run: (ctx) => ctx.app().focusNextPane(),
  },
  {
    id: "prev-pane",
    label: "Previous Pane",
    category: "terminal",
    defaultCombo: metaCombo("["),
    scope: "any",
    run: (ctx) => ctx.app().focusPrevPane(),
  },
  {
    id: "history-back",
    label: "Navigate Back",
    category: "app",
    defaultCombo: metaCombo("[", false, false, true), // Cmd+Ctrl+[
    scope: "primary",
    run: (ctx) => ctx.navigateBack(),
  },
  {
    id: "history-forward",
    label: "Navigate Forward",
    category: "app",
    defaultCombo: metaCombo("]", false, false, true), // Cmd+Ctrl+]
    scope: "primary",
    run: (ctx) => ctx.navigateForward(),
  },
  {
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    category: "app",
    defaultCombo: metaCombo("\\"),
    scope: "primary",
    run: (ctx) => ctx.toggleSidebar(),
  },
  {
    id: "focus-sidebar",
    label: "Focus Sidebar",
    category: "app",
    defaultCombo: metaCombo("e", true), // Cmd+Shift+E
    scope: "primary",
    run: (ctx) => {
      // A visible sidebar takes focus now: the key that follows ⌘⇧E (an arrow,
      // Home) can arrive before the next frame, and would reach the terminal.
      if (ctx.focusRegion("sidebar")) return;
      // A hidden sidebar has no rows to focus; show it and wait for the commit.
      ctx.ensureSidebarVisible();
      ctx.focusRegionWhenReady("sidebar");
    },
  },
  {
    id: "focus-tabbar",
    label: "Focus Tab Bar",
    category: "app",
    defaultCombo: metaCombo("y", true), // Cmd+Shift+Y
    scope: "any",
    run: (ctx) => void ctx.focusRegion("tabbar"),
  },
  {
    id: "focus-next-region",
    label: "Focus Next Region",
    category: "app",
    defaultCombo: plainCombo("F6"),
    scope: "any",
    run: (ctx) => ctx.cycleRegion(1),
  },
  {
    id: "focus-prev-region",
    label: "Focus Previous Region",
    category: "app",
    defaultCombo: plainCombo("F6", true),
    scope: "any",
    run: (ctx) => ctx.cycleRegion(-1),
  },
  {
    id: "new-agent",
    label: "New Agent",
    category: "workspace",
    defaultCombo: metaCombo("n"),
    scope: "any",
    run: (ctx) => ctx.startNewAgent(),
  },
  {
    id: "new-workspace",
    label: "New Workspace",
    category: "workspace",
    defaultCombo: metaCombo("n", true),
    scope: "primary",
    run: (ctx) => ctx.chrome.openNewWorkspace(),
  },
  {
    id: "next-workspace",
    label: "Next Workspace",
    category: "workspace",
    defaultCombo: metaCombo("ArrowDown", false, false, true), // Ctrl+Cmd+ArrowDown
    scope: "primary",
    run: (ctx) => ctx.stepWorkspace(1),
  },
  {
    id: "prev-workspace",
    label: "Previous Workspace",
    category: "workspace",
    defaultCombo: metaCombo("ArrowUp", false, false, true), // Ctrl+Cmd+ArrowUp
    scope: "primary",
    run: (ctx) => ctx.stepWorkspace(-1),
  },
  ...Array.from(
    { length: 9 },
    (_, i): CommandDef => ({
      id: `select-tab-${i + 1}`,
      label: `Select Tab ${i + 1}`,
      category: "workspace",
      defaultCombo: metaCombo(String(i + 1)),
      scope: "any",
      run: (ctx) => ctx.app().selectTabByGlobalIndex(i),
    }),
  ),
  {
    id: "settings",
    label: "Settings",
    category: "app",
    defaultCombo: metaCombo(","),
    scope: "primary",
    run: (ctx) => ctx.chrome.openSettings(),
  },
  {
    id: "command-palette",
    label: "Command Palette",
    category: "app",
    defaultCombo: metaCombo("k"),
    scope: "primary",
    run: (ctx) => ctx.chrome.togglePalette(),
  },
  {
    id: "new-browser",
    label: "New Browser Window",
    category: "workspace",
    defaultCombo: metaCombo("b", true),
    scope: "any",
    run: (ctx) => ctx.app().addBrowserTab("about:blank"),
  },
  {
    id: "browser-zoom-in",
    label: "Browser Zoom In",
    category: "browser",
    defaultCombo: metaCombo("="),
    scope: "any",
    run: (ctx) => ctx.focusedBrowser()?.zoomIn(),
  },
  {
    id: "browser-zoom-out",
    label: "Browser Zoom Out",
    category: "browser",
    defaultCombo: metaCombo("-"),
    scope: "any",
    run: (ctx) => ctx.focusedBrowser()?.zoomOut(),
  },
  {
    id: "browser-zoom-reset",
    label: "Browser Zoom Reset",
    category: "browser",
    defaultCombo: metaCombo("0"),
    scope: "any",
    run: (ctx) => ctx.focusedBrowser()?.zoomReset(),
  },
  {
    id: "browser-reload",
    label: "Browser Reload",
    category: "browser",
    defaultCombo: metaCombo("r"),
    scope: "any",
    run: (ctx) => ctx.focusedBrowser()?.reload(),
  },
  {
    id: "browser-focus-url",
    label: "Focus URL Bar",
    category: "browser",
    defaultCombo: metaCombo("l"),
    scope: "any",
    run: (ctx) => {
      const paneId = ctx.focusedBrowserPaneId();
      if (paneId) ctx.focusBrowserUrlBar(paneId);
    },
  },
  {
    id: "browser-back",
    label: "Browser Back",
    category: "browser",
    defaultCombo: metaCombo("["),
    scope: "any",
    run: (ctx) => ctx.focusedBrowser()?.goBack(),
  },
  {
    id: "browser-forward",
    label: "Browser Forward",
    category: "browser",
    defaultCombo: metaCombo("]"),
    scope: "any",
    run: (ctx) => ctx.focusedBrowser()?.goForward(),
  },
  {
    id: "browser-find",
    label: "Find in Page",
    category: "browser",
    defaultCombo: metaCombo("f"),
    scope: "any",
    run: (ctx) => {
      const paneId = ctx.focusedBrowserPaneId();
      if (paneId) ctx.requestUi({ type: "pane-search", paneId });
    },
  },
  {
    // No `run`: the focused terminal handles its own search, so the key must
    // fall through to it. Edit › Find… sends `find` instead.
    id: "terminal-search",
    label: "Search Terminal",
    category: "terminal",
    defaultCombo: metaCombo("f"),
    scope: "any",
  },
  {
    id: "reopen-pane",
    label: "Reopen Closed Pane",
    category: "workspace",
    defaultCombo: metaCombo("t", true),
    scope: "any",
    run: (ctx) => ctx.app().reopenClosedPane(),
  },
  {
    id: "copy-branch",
    label: "Copy Branch Name",
    category: "workspace",
    defaultCombo: metaCombo(".", true),
    scope: "any",
    run: (ctx) => {
      const branch = ctx.active().workspace?.branch;
      if (branch) ctx.copyToClipboard(branch, "copy-branch");
    },
  },
  {
    id: "open-diff",
    label: "Open Diff",
    category: "workspace",
    defaultCombo: metaCombo("g", true), // Cmd+Shift+G
    scope: "any",
    run: (ctx) => {
      if (ctx.diffOpensInNewPanel()) ctx.app().openDiffInNewPanel();
      else ctx.app().openOrFocusDiff();
    },
  },
  {
    id: "split-panel-right",
    label: "Split Panel Right",
    category: "workspace",
    defaultCombo: metaCombo("\\", false, true),
    scope: "any",
    run: (ctx) => ctx.app().splitPanel("horizontal"),
  },
  {
    id: "split-panel-down",
    label: "Split Panel Down",
    category: "workspace",
    defaultCombo: metaCombo("\\", true, true),
    scope: "any",
    run: (ctx) => ctx.app().splitPanel("vertical"),
  },
  {
    id: "focus-next-panel",
    label: "Focus Next Panel",
    category: "workspace",
    defaultCombo: metaCombo("]", false, true),
    scope: "any",
    run: (ctx) => ctx.app().focusNextPanel(),
  },
  {
    id: "focus-prev-panel",
    label: "Focus Previous Panel",
    category: "workspace",
    defaultCombo: metaCombo("[", false, true),
    scope: "any",
    run: (ctx) => ctx.app().focusPrevPanel(),
  },
  {
    // No default combo — ⌘⇧E and ⌘⇧Y are already spoken for; bind one in
    // Settings › Keybindings. The notifications popover lives in the sidebar,
    // so this is primary-only like `focus-sidebar`.
    id: "open-notifications",
    label: "Open Notifications",
    category: "app",
    defaultCombo: null,
    scope: "primary",
    run: (ctx) => ctx.requestUi({ type: "open-notifications" }),
  },

  // ── Shared, with no binding ─────────────────────────────────────────────
  {
    id: "close-panel",
    label: "Close Panel",
    category: "workspace",
    scope: "any",
    run: (ctx) => {
      const panelId = ctx.activePanelId();
      if (panelId) ctx.app().closePanel(panelId);
    },
  },
  {
    id: "move-tab-to-next-panel",
    label: "Move Tab to Next Panel",
    category: "workspace",
    scope: "any",
    run: (ctx) => ctx.moveTabToNextPanel(),
  },

  // ── File ────────────────────────────────────────────────────────────────
  {
    id: "add-project",
    label: "Add Project",
    category: "app",
    scope: "primary",
    native: "dialog", // `dialog.openDirectory` — no filesystem picker.
    run: (ctx) => ctx.chrome.addProject(),
  },
  {
    id: "open-in-editor",
    label: "Open in Editor",
    category: "workspace",
    scope: "primary",
    native: "shell", // `shell.openInEditor` — no local editor process.
    run: (ctx) => {
      const { path } = ctx.active();
      if (path) ctx.openInEditor(path);
    },
  },
  {
    id: "reveal-in-finder",
    label: "Reveal in Finder",
    category: "workspace",
    scope: "primary",
    native: "shell", // `shell.showItemInFolder` — no Finder.
    run: (ctx) => {
      const { path } = ctx.active();
      if (path) ctx.revealInFinder(path);
    },
  },
  {
    // Closing it is all the renderer has to do.
    id: "close-window",
    label: "Close Window",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.closeWindow(),
  },

  // ── Edit ────────────────────────────────────────────────────────────────
  {
    id: "find",
    label: "Find",
    category: "app",
    scope: "primary",
    run: (ctx) => {
      const paneId = ctx.focusedPaneId();
      if (paneId) ctx.requestUi({ type: "pane-search", paneId });
    },
  },
  {
    id: "copy-workspace-path",
    label: "Copy Workspace Path",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { path } = ctx.active();
      if (path) ctx.copyToClipboard(path, "copy-workspace-path");
    },
  },

  // ── View ────────────────────────────────────────────────────────────────
  {
    id: "notifications",
    label: "Notifications",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.requestUi({ type: "open-notifications" }),
  },
  {
    // Linear when the active project is linked to a team, else GitHub — the
    // same choice `useIssuesShortcut` makes for the empty states.
    id: "your-issues",
    label: "Your Issues",
    category: "app",
    scope: "primary",
    run: (ctx) =>
      ctx.chrome.openPaletteView(
        ctx.activeProjectLinkedToLinear() ? "linear-all" : "github-all",
      ),
  },
  {
    id: "home",
    label: "Home",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.app().setActiveWorkspace(HOME_PATH),
  },
  {
    id: "processes",
    label: "Processes",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.chrome.openPaletteView("processes"),
  },
  {
    id: "stats",
    label: "Stats",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.chrome.openPaletteView("stats"),
  },

  // ── Workspace ───────────────────────────────────────────────────────────
  {
    id: "switch-workspace",
    label: "Switch Workspace",
    category: "workspace",
    scope: "primary",
    run: (ctx, args) => {
      const path = stringArg(args, "path");
      if (path) ctx.switchToWorkspace(path);
    },
  },
  {
    id: "rename-workspace",
    label: "Rename Workspace",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project, path } = ctx.active();
      if (!project || !path) return;
      ctx.ensureSidebarVisible();
      ctx.requestUi({ type: "rename-workspace", projectId: project.id, path });
    },
  },
  {
    id: "hide-workspace",
    label: "Hide Workspace",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project, path } = ctx.active();
      if (project && path) ctx.hideWorkspace(project.id, path);
    },
  },
  {
    id: "move-to-folder",
    label: "Move to Folder",
    category: "workspace",
    scope: "primary",
    run: (ctx, args) =>
      ctx.moveActiveWorkspaceToFolder(stringArg(args, "folderId")),
  },
  {
    id: "merge-worktree",
    label: "Merge Worktree",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project, path } = ctx.active();
      if (!project || !path) return;
      ctx.ensureSidebarVisible();
      ctx.requestUi({ type: "merge-worktree", projectId: project.id, path });
    },
  },
  {
    id: "delete-worktree",
    label: "Delete Worktree",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project, path } = ctx.active();
      if (!project || !path) return;
      ctx.ensureSidebarVisible();
      ctx.requestUi({ type: "delete-worktree", projectId: project.id, path });
    },
  },
  {
    id: "project-settings",
    label: "Project Settings",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project } = ctx.active();
      if (project) ctx.chrome.openProjectSettings(project.id);
    },
  },
  {
    id: "remove-project",
    label: "Remove Project",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project } = ctx.active();
      if (!project) return;
      ctx.ensureSidebarVisible();
      ctx.requestUi({ type: "remove-project", projectId: project.id });
    },
  },

  // ── Pane ────────────────────────────────────────────────────────────────
  {
    id: "split-with",
    label: "Split With",
    category: "terminal",
    scope: "primary",
    run: (ctx, args) => {
      const kind = (stringArg(args, "contentType") ??
        "terminal") as CommandPaneKind;
      const paneCommand =
        kind === "agent" ? ctx.agentCommand(ctx.active().path) : undefined;
      // A plain terminal is the default content — leave it unset.
      ctx.splitFocusedPaneWith(
        kind === "terminal" ? undefined : kind,
        paneCommand,
      );
    },
  },
  {
    id: "convert-to",
    label: "Convert To",
    category: "terminal",
    scope: "primary",
    run: (ctx, args) => {
      const kind = stringArg(args, "contentType");
      if (kind) ctx.convertFocusedPaneTo(kind as CommandPaneKind);
    },
  },
  {
    id: "detach-pane",
    label: "Move Pane to New Window",
    category: "terminal",
    scope: "primary",
    // `window.detachTab`/`window.setPosition` — no native chrome, and
    // `window.open` under a popup blocker is not a substitute (ADR-156).
    native: "window",
    run: (ctx) => {
      const paneId = ctx.focusedPaneId();
      if (paneId) ctx.movePaneToNewWindow(paneId);
    },
  },

  // ── Agents ──────────────────────────────────────────────────────────────
  {
    id: "run-setup-script",
    label: "Run Setup Script",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const { project, path } = ctx.active();
      if (project?.worktreeStartScript && path) {
        ctx.runSetupScript(path, project.worktreeStartScript);
      }
    },
  },
  {
    id: "view-all-agents",
    label: "View All Agents",
    category: "workspace",
    scope: "primary",
    run: (ctx) => ctx.chrome.openAgents(),
  },
  {
    id: "focus-agent",
    label: "Focus Agent",
    category: "workspace",
    scope: "primary",
    run: (ctx, args) => {
      const agentId = stringArg(args, "agentId");
      if (agentId) ctx.chrome.resumeAgent(agentId);
    },
  },
  {
    id: "remote-control",
    label: "Remote Control",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.chrome.openSettings("remote"),
  },

  // ── Window ──────────────────────────────────────────────────────────────
  {
    id: "pin-tab",
    label: "Pin Tab",
    category: "workspace",
    scope: "primary",
    run: (ctx) => {
      const tabId = ctx.activeTabId();
      if (tabId) ctx.app().togglePinTab(tabId);
    },
  },
  {
    id: "detach-tab",
    label: "Move Tab to New Window",
    category: "workspace",
    scope: "primary",
    native: "window",
    run: (ctx) => {
      const tabId = ctx.activeTabId();
      if (tabId) ctx.detachTab(tabId);
    },
  },

  // ── Help ────────────────────────────────────────────────────────────────
  // Main opens the links itself; the handlers exist so every menu command has
  // a renderer-side action even if the routing ever changes. `openExternal`
  // works on the web too (a new browser tab), so none of these is native.
  {
    id: "help-docs",
    label: "Manor Help",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.openExternal(EXTERNAL_LINKS.docs),
  },
  {
    id: "help-shortcuts",
    label: "Keyboard Shortcuts",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.chrome.openSettings("keybindings"),
  },
  {
    id: "help-release-notes",
    label: "Release Notes",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.openExternal(EXTERNAL_LINKS.releaseNotes),
  },
  {
    id: "submit-feedback",
    label: "Submit Feedback",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.chrome.openFeedback(),
  },
  {
    id: "help-report-issue",
    label: "Report an Issue on GitHub",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.openExternal(EXTERNAL_LINKS.newIssue),
  },
  {
    id: "ghosts",
    label: "Ghosts!?",
    category: "app",
    scope: "primary",
    run: (ctx) => ctx.chrome.showGhosts(),
  },
];

// ── Lookups and derived views ─────────────────────────────────────────────

const BY_ID: ReadonlyMap<string, CommandDef> = new Map(
  COMMANDS.map((def) => [def.id, def]),
);

/** The table entry for `id`, if there is one. */
export function getCommand(id: string): CommandDef | undefined {
  return BY_ID.get(id);
}

/** Whether `commandId` does anything on the web app (ADR-178 ticket 6). */
export function commandAvailableOnWeb(commandId: string): boolean {
  const native = BY_ID.get(commandId)?.native;
  return !native || !UNAVAILABLE_NAMESPACES.has(native);
}

/**
 * The table as the current platform sees it — the one place the web filter
 * is applied. On the web a native-only command is simply absent: it has no
 * handler, and the palette never lists it.
 */
export function availableCommands({
  web,
}: {
  web: boolean;
}): readonly CommandDef[] {
  return web
    ? COMMANDS.filter((def) => commandAvailableOnWeb(def.id))
    : COMMANDS;
}

/** A command→action map, as the keyboard and menu dispatchers take it. */
export type CommandHandler = (args?: CommandArgs) => void;

/**
 * The command→action map for one window: `run` over the table.
 *
 * With only a `SharedCommandContext` (a popout, or a test that needs no
 * chrome) the map holds the `scope: "any"` commands alone — the primary-only
 * ones are left for the dispatcher's fallback to forward. Commands with no
 * `run` get no entry, so their key falls through to whoever services it.
 */
export function commandHandlers(
  ctx: SharedCommandContext | CommandContext,
  { web, primary }: { web: boolean; primary: boolean },
): Record<string, CommandHandler> {
  const handlers: Record<string, CommandHandler> = {};
  for (const def of availableCommands({ web })) {
    if (!def.run) continue;
    if (def.scope === "any") {
      const run = def.run;
      handlers[def.id] = (args) => run(ctx, args);
    } else if (primary && "chrome" in ctx) {
      const run = def.run;
      handlers[def.id] = (args) => run(ctx, args);
    }
  }
  return handlers;
}
