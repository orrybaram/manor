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
  "open-diff",
  ...Array.from({ length: 9 }, (_, i) => `select-tab-${i + 1}`),
]);

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
    folders: { id: string; name: string }[];
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
