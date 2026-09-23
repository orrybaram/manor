/**
 * The command catalog behind the native application menu (ADR-170).
 *
 * Like `keybinding-defs.ts`, this module has no DOM references and imports
 * only the command table (`commands.ts`), which every list here is derived
 * from: Electron main imports it to build the menu template, and the renderer
 * imports it to dispatch the commands main sends back. A stray
 * `window`/`document` reference here breaks main at startup.
 */

import { COMMANDS, commandAvailableOnWeb } from "./commands";

export { EXTERNAL_LINKS } from "./commands";

/**
 * The commands a detached window can service itself — the table's runnable
 * `scope: "any"` entries. Main routes these to the focused window and
 * everything else to the primary.
 */
export const SHARED_WINDOW_COMMANDS: ReadonlySet<string> = new Set<string>(
  COMMANDS.filter((def) => def.scope === "any" && def.run).map((def) => def.id),
);

/**
 * Keybinding commands only the primary window implements. A popout that sees
 * one of these asks main to focus the primary window and run it there
 * (`keybindings.runInMainWindow`); main rejects any other id.
 */
export const MAIN_WINDOW_KEYBINDINGS: ReadonlySet<string> = new Set<string>(
  COMMANDS.filter(
    (def) => def.scope === "primary" && def.defaultCombo !== undefined,
  ).map((def) => def.id),
);

/**
 * Commands whose only implementation reaches a namespace `src/bridge/unavailable.ts`
 * has no browser meaning for at all — ADR-178's "what can never mirror in a
 * browser" table, expressed as command ids instead of preload namespaces.
 * Derived from the table's `native` field; `availableCommands` (`commands.ts`)
 * is where the web app actually applies it.
 */
export const NATIVE_ONLY_COMMANDS: ReadonlySet<string> = new Set<string>(
  COMMANDS.filter((def) => !commandAvailableOnWeb(def.id)).map((def) => def.id),
);

/**
 * Payload of the main → renderer `keybindings.forwardedCommand` event
 * (ADR-180 D5): a bound combo pressed somewhere the renderer's own key
 * handler can't see it — inside a web page (`webview`) or in a popout for a
 * primary-only command (`popout`).
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
