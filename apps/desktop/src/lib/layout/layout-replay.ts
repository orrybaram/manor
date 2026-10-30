/**
 * A workspace's layout, rebuilt in another workspace as layout commands.
 *
 * Moving a workspace to another host recreates it there
 * (`electron/projects/workspace-host-move.ts`), and its tabs come with it:
 * `layoutReplay` reads the source's `WorkspaceLayout` and answers the
 * commands that build the same panels, tabs and splits in the target, every
 * pane, tab and panel id fresh. Nothing runs on the old ids: a replay is a
 * second set of panes, not a view of the first.
 *
 * What comes across:
 * - the panel tree: each split's direction and ratio, built split by split
 *   with `split-panel-with-new-tab` and `update-panel-ratio`,
 * - each panel's tabs, in order, with their titles and pins,
 * - each tab's pane tree whole (its splits and ratios ride in the `new-tab`),
 * - file panes' open file and browser panes' url, as they were. A file
 *   pane's `filePath` is workspace-relative, so it holds in the new root; one
 *   that is absolute under the source root is moved under the target's.
 *
 * Terminals start fresh. Their cwd is the shell's last, moved from the
 * source root to the target root (`cwds`): the caller types the `cd`. A cwd
 * outside the source root, or none, is the target root, and needs nothing.
 *
 * **What the target already has.** The target's own tabs stay, the
 * replayed ones after them, and a Setup tab still running its script is one
 * of them. The one exception is a lone, never-started default tab (a
 * single terminal called "Terminal" with no session): nothing is lost
 * closing it, so the replay takes its place. The source's first panel
 * lands in the target's first (top-left) panel; the source's other panels
 * split off it.
 *
 * Pure: the reducer (`./commands/`) is what proves it, and the tests run the
 * answer through it.
 */

import type { LayoutCommand } from "./commands";
import { newPaneId, newPanelId, newTabId } from "./ids";
import { clonePaneTree, type PaneNode } from "./pane-tree";
import { allPanelIds, type PanelNode } from "./panel-tree";
import type { PersistedPaneSession } from "./protocol";
import type { Tab, WorkspaceLayout } from "./workspace-layout";

/**
 * The panel id the commands give the target's first panel when the target
 * has no layout yet: the server mints that panel with the first command
 * (`commands[0]`, a `new-tab` naming no panel), and the caller binds this
 * to it (`bindPanelId`) before sending the rest.
 */
export const TARGET_FIRST_PANEL = "panel-replay-target";

/** The default title of a fresh terminal tab (`createTab`). */
const DEFAULT_TAB_TITLE = "Terminal";

export interface LayoutReplayInput {
  source: WorkspaceLayout;
  /** The source's panes' sessions: where each shell last was. */
  paneSessions: Readonly<Record<string, PersistedPaneSession>>;
  sourceRoot: string;
  targetRoot: string;
  /** The target's layout as it stands; null before it has one. */
  target: {
    layout: WorkspaceLayout;
    paneSessions: Readonly<Record<string, PersistedPaneSession>>;
  } | null;
}

export interface LayoutReplay {
  /** The commands, in order, for the target workspace. */
  commands: LayoutCommand[];
  /** Each source pane's fresh id in the target. */
  paneIds: Record<string, string>;
  /** A fresh terminal's cwd, by its target pane id, where it is not the target root. */
  cwds: Record<string, string>;
}

/** `path` under `targetRoot`, when it is `sourceRoot` or under it; else null. */
export function mapUnderRoot(path: string, sourceRoot: string, targetRoot: string): string | null {
  const from = trimSeparator(sourceRoot);
  const to = trimSeparator(targetRoot);
  if (path === from) return to;
  for (const sep of ["/", "\\"]) {
    if (path.startsWith(from + sep)) {
      const rest = path.slice(from.length + 1).split(sep).join("/");
      return `${to}/${rest}`;
    }
  }
  return null;
}

function trimSeparator(path: string): string {
  return path.length > 1 && /[/\\]$/.test(path) ? path.slice(0, -1) : path;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\");
}

/** `command` with every panel id `from` read as `to`. */
export function bindPanelId(command: LayoutCommand, from: string, to: string): LayoutCommand {
  const swap = (id: string) => (id === from ? to : id);
  switch (command.type) {
    case "new-tab":
      return command.panelId === undefined ? command : { ...command, panelId: swap(command.panelId) };
    case "split-panel-with-new-tab":
      return { ...command, sourcePanelId: swap(command.sourcePanelId) };
    case "update-panel-ratio":
      return { ...command, firstPanelId: swap(command.firstPanelId) };
    case "reorder-tabs":
      return { ...command, panelId: swap(command.panelId) };
    default:
      return command;
  }
}

/** The source's panel tree without panels that hold no tab. Null when none do. */
function withoutEmptyPanels(node: PanelNode, layout: WorkspaceLayout): PanelNode | null {
  if (node.type === "leaf") {
    return (layout.panels[node.panelId]?.tabs.length ?? 0) > 0 ? node : null;
  }
  const first = withoutEmptyPanels(node.first, layout);
  const second = withoutEmptyPanels(node.second, layout);
  if (!first || !second) return first ?? second;
  return { ...node, first, second };
}

function firstLeaf(node: PanelNode): string {
  return node.type === "leaf" ? node.panelId : firstLeaf(node.first);
}

/** The target's lone default tab, when closing it loses nothing: see the module header. */
function replaceableTab(target: LayoutReplayInput["target"]): string | null {
  if (!target) return null;
  const tabs = Object.values(target.layout.panels).flatMap((p) => p.tabs);
  if (tabs.length !== 1) return null;
  const [tab] = tabs;
  const root = tab.rootNode;
  const terminal =
    root.type === "leaf" && (root.contentType === undefined || root.contentType === "terminal");
  if (!terminal || tab.title !== DEFAULT_TAB_TITLE) return null;
  return target.paneSessions[root.paneId] ? null : tab.id;
}

/** Rebuild `input.source` in the target (see the module header). */
export function layoutReplay(input: LayoutReplayInput): LayoutReplay {
  const { source, paneSessions, sourceRoot, targetRoot, target } = input;
  const commands: LayoutCommand[] = [];
  const paneIds: Record<string, string> = {};
  const cwds: Record<string, string> = {};

  const tree = withoutEmptyPanels(source.panelTree, source);
  if (!tree) return { commands, paneIds, cwds };

  const remapLeaves = (node: PaneNode): PaneNode => {
    if (node.type === "split") {
      return { ...node, first: remapLeaves(node.first), second: remapLeaves(node.second) };
    }
    if (node.contentType === "file" && node.filePath && isAbsolute(node.filePath)) {
      const mapped = mapUnderRoot(node.filePath, sourceRoot, targetRoot);
      if (mapped) return { ...node, filePath: mapped };
    }
    return node;
  };

  /** A source tab with fresh ids, its terminals' cwds noted. */
  const fresh = (tab: Tab): Tab => {
    const { tree: rootNode, idMap } = clonePaneTree(tab.rootNode, newPaneId);
    Object.assign(paneIds, idMap);
    const sourceOf = new Map(Object.entries(idMap).map(([from, to]) => [to, from]));
    const walk = (node: PaneNode) => {
      if (node.type === "split") {
        walk(node.first);
        walk(node.second);
        return;
      }
      if (node.contentType === "browser" || node.contentType === "file") return;
      const sourceId = sourceOf.get(node.paneId);
      const lastCwd = sourceId ? paneSessions[sourceId]?.lastCwd : null;
      const mapped = lastCwd ? mapUnderRoot(lastCwd, sourceRoot, targetRoot) : null;
      if (mapped && mapped !== trimSeparator(targetRoot)) cwds[node.paneId] = mapped;
    };
    walk(rootNode);
    return { id: newTabId(), title: tab.title, rootNode: remapLeaves(rootNode) };
  };

  const replaced = replaceableTab(target);
  const firstPanel = target ? allPanelIds(target.layout.panelTree)[0] : TARGET_FIRST_PANEL;

  // Which target panel each source panel becomes, and the tab a new panel
  // was opened with (`split-panel-with-new-tab` needs one).
  const panelOf = new Map<string, string>();
  const seeded = new Map<string, Tab>();
  const freshTabs = new Map<string, Tab>();
  const freshOf = (tab: Tab): Tab => {
    let made = freshTabs.get(tab.id);
    if (!made) {
      made = fresh(tab);
      freshTabs.set(tab.id, made);
    }
    return made;
  };

  // No layout yet: the first tab is what makes the target's first panel.
  if (!target) {
    const firstSource = source.panels[firstLeaf(tree)];
    const tab = freshOf(firstSource.tabs[0]);
    seeded.set(firstSource.id, tab);
    commands.push({ type: "new-tab", tab, select: false });
  }

  // `at` is the target panel standing for `node`. A split of `at` keeps
  // `at` first and opens the second half's first panel beside it; its ratio
  // is set at once, while `at` is still that split's direct first child
  // (`update-panel-ratio` finds a split by it).
  const build = (node: PanelNode, at: string) => {
    if (node.type === "leaf") {
      panelOf.set(node.panelId, at);
      return;
    }
    const seedSource = source.panels[firstLeaf(node.second)];
    const tab = freshOf(seedSource.tabs[0]);
    const opened = newPanelId();
    seeded.set(seedSource.id, tab);
    commands.push({
      type: "split-panel-with-new-tab",
      tab,
      direction: node.direction,
      newPanelId: opened,
      sourcePanelId: at,
    });
    commands.push({ type: "update-panel-ratio", firstPanelId: at, ratio: node.ratio });
    build(node.first, at);
    build(node.second, opened);
  };
  build(tree, firstPanel);

  for (const sourcePanelId of allPanelIds(tree)) {
    const panel = source.panels[sourcePanelId];
    const at = panelOf.get(sourcePanelId)!;
    const seed = seeded.get(sourcePanelId);
    for (const tab of panel.tabs) {
      const made = freshOf(tab);
      if (made === seed) continue;
      commands.push({ type: "new-tab", tab: made, panelId: at, select: false });
    }
    // Pinning moves a tab to the end of the pinned block: pinned in pin
    // order, they line up as they were.
    for (const tabId of panel.pinnedTabIds) {
      const made = freshTabs.get(tabId);
      if (made) commands.push({ type: "toggle-pin-tab", tabId: made.id });
    }
  }

  if (replaced) commands.push({ type: "close-tab", tabId: replaced });
  return { commands, paneIds, cwds };
}
