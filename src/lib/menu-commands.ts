/**
 * The command catalog behind the native application menu (ADR-170).
 *
 * Like `keybinding-defs.ts`, this is a leaf module with ZERO runtime imports
 * and no DOM references: Electron main imports it to build the menu template,
 * and the renderer imports it to dispatch the commands main sends back. A
 * stray `window`/`document` reference here breaks main at startup.
 */

import type { DEFAULT_KEYBINDINGS } from "./keybinding-defs";

/**
 * Menu items that are NOT backed by a keybinding. Everything else in the menu
 * is addressed by its keybinding id (see `DEFAULT_KEYBINDINGS`).
 */
export const MENU_ONLY_COMMANDS = [
  "add-project",
  "open-in-editor",
  "reveal-in-finder",
  "close-window",
  "find",
  "copy-workspace-path",
  "notifications",
  "your-issues",
  "home",
  "processes",
  "stats",
  "switch-workspace",
  "rename-workspace",
  "hide-workspace",
  "move-to-folder",
  "merge-worktree",
  "delete-worktree",
  "project-settings",
  "remove-project",
  "split-with",
  "convert-to",
  "detach-pane",
  "run-setup-script",
  "view-all-agents",
  "focus-agent",
  "remote-control",
  "pin-tab",
  "detach-tab",
  "help-docs",
  "help-shortcuts",
  "help-release-notes",
  "submit-feedback",
  "help-report-issue",
  "ghosts",
] as const;

export type MenuOnlyCommandId = (typeof MENU_ONLY_COMMANDS)[number];

/**
 * `DEFAULT_KEYBINDINGS` is annotated `KeybindingDef[]`, so its ids widen to
 * `string` and this union collapses to `string`. The shape is kept anyway to
 * document intent (and to tighten automatically if the registry is ever made
 * literal-typed); use `MenuOnlyCommandId` when a literal union is needed.
 */
export type MenuCommandId =
  | (typeof DEFAULT_KEYBINDINGS)[number]["id"]
  | MenuOnlyCommandId;

/**
 * The commands `createSharedKeybindingHandlers` implements, i.e. the ones a
 * detached window can service itself. Main routes these to the focused window
 * and everything else to the primary.
 *
 * Kept in sync by a test in `src/lib/__tests__/keybinding-commands.test.ts`;
 * it cannot be derived here because `keybinding-commands.ts` touches the DOM.
 */
export const SHARED_WINDOW_COMMANDS: ReadonlySet<string> = new Set<string>([
  "new-tab",
  "new-agent",
  "new-browser",
  "split-h",
  "split-v",
  "close-pane",
  "reopen-pane",
  "close-tab",
  "next-tab",
  "prev-tab",
  "next-pane",
  "prev-pane",
  "copy-branch",
  "split-panel-right",
  "split-panel-down",
  "focus-next-panel",
  "focus-prev-panel",
  "close-panel",
  "move-tab-to-next-panel",
  "browser-zoom-in",
  "browser-zoom-out",
  "browser-zoom-reset",
  "browser-reload",
  "browser-focus-url",
  "browser-back",
  "browser-forward",
  "browser-find",
  "open-diff",
  "focus-next-region",
  "focus-prev-region",
  "focus-tabbar",
  ...Array.from({ length: 9 }, (_, i) => `select-tab-${i + 1}`),
]);

/**
 * Keybinding commands only the primary window implements. A popout that sees
 * one of these asks main to focus the primary window and run it there
 * (`keybindings:runInMainWindow`); main rejects any other id.
 */
export const MAIN_WINDOW_KEYBINDINGS: ReadonlySet<string> = new Set<string>([
  "settings",
  "command-palette",
  "new-workspace",
  "next-workspace",
  "prev-workspace",
  "history-back",
  "history-forward",
  "toggle-sidebar",
  "focus-sidebar",
  "open-notifications",
]);

/**
 * Commands whose only implementation reaches a namespace `src/web/unavailable.ts`
 * has no browser meaning for at all — ADR-178's "what can never mirror in a
 * browser" table, expressed as command ids instead of preload namespaces.
 * `commandAvailableOnWeb` filters these out of the command palette and turns
 * them into no-ops for the keybinding and menu-command dispatchers when
 * `isWebApp()` (`platform.ts`). Kept here, beside the rest of the command
 * catalog, so a command's web availability is decided next to its id and is
 * unit-testable without touching the DOM this module is built to avoid.
 */
export const NATIVE_ONLY_COMMANDS: ReadonlySet<string> = new Set<string>([
  // `dialog.openDirectory` — no filesystem picker in a browser tab.
  "add-project",
  "new-project",
  // `shell.openInEditor` — no local editor process to hand a path to.
  "open-in-editor",
  // `shell.showItemInFolder` — no Finder to reveal anything in.
  "reveal-in-finder",
  // `window.detachTab`/`window.setPosition` — no native chrome, and
  // `window.open` under a popup blocker is not a substitute (ADR-156).
  "detach-pane",
  "detach-tab",
  // `shell.openExternal`, reached directly rather than through a `<Link>`.
  "help-docs",
  "help-release-notes",
  "help-report-issue",
]);

/** Whether `commandId` does anything on the web app (ADR-178 ticket 6). */
export function commandAvailableOnWeb(commandId: string): boolean {
  return !NATIVE_ONLY_COMMANDS.has(commandId);
}

/**
 * Payload of the main → renderer `keybinding-command` channel: a bound combo
 * pressed somewhere the renderer's own key handler can't see it — inside a web
 * page (`webview`) or in a popout for a primary-only command (`popout`).
 */
export interface ForwardedCommandPayload {
  commandId: string;
  source: "webview" | "popout";
  /** The browser pane the key was pressed in, for `source: "webview"`. */
  paneId?: string;
}

/** Payload of the main → renderer `menu-command` channel. */
export interface MenuCommandPayload {
  commandId: string;
  args?: Record<string, unknown>;
}

/**
 * The derived slice of renderer state main needs to label menu items and
 * decide what is enabled or checked. Never authoritative — the renderer stores
 * remain the source of truth.
 */
export interface MenuContext {
  activeWorkspacePath: string | null;
  isHome: boolean;
  workspace: {
    projectId: string;
    name: string;
    branch: string;
    isMain: boolean;
    folderId: string | null;
  } | null;
  project: {
    id: string;
    name: string;
    hasSetupScript: boolean;
    /** `name` is the folder's full path (`epic / api`) since ADR-172. */
    folders: { id: string; name: string; parentId: string | null }[];
  } | null;
  /** Visible projects in sidebar order, each with its visible workspaces. */
  projects: {
    id: string;
    name: string;
    workspaces: { path: string; label: string }[];
  }[];
  /** Active agents only. */
  agents: { id: string; name: string; workspaceLabel: string | null }[];
  focusedPane: {
    id: string;
    contentType: "terminal" | "browser" | "diff" | "agent";
  } | null;
  activeTab: { id: string; pinned: boolean } | null;
  panelCount: number;
  editorName: string | null;
}

/** URLs opened by the Help menu. */
export const EXTERNAL_LINKS = {
  docs: "https://github.com/orrybaram/manor#readme",
  releaseNotes: "https://github.com/orrybaram/manor/blob/main/CHANGELOG.md",
  newIssue: "https://github.com/orrybaram/manor/issues/new",
} as const;
