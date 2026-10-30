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
 * **Held tabs.** A tab holding one of `heldPaneIds` (an agent's) is left
 * out of `commands` and added by `heldCommands`, into the panel it was in
 * and put back in its place, so its caller can queue each held pane's
 * launch line in between: a launch starts when the apply adds its pane.
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
import { allPaneIds, clonePaneTree, type PaneNode } from "./pane-tree";
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
  /**
   * Source panes whose tabs wait for `heldCommands` (an agent's, whose
   * launch line must be queued before its pane is added). Their panes get
   * no `cwd`.
   */
  heldPaneIds?: ReadonlySet<string>;
}

export interface LayoutReplay {
  /** The commands, in order, for the target workspace: everything but the held tabs. */
  commands: LayoutCommand[];
  /**
   * The held tabs, after `commands`: added where they were, in their order.
   * A panel holding only held tabs is opened with a placeholder tab in
   * `commands`, closed here. Empty with nothing held.
   */
  heldCommands: LayoutCommand[];
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
  const held = input.heldPaneIds ?? new Set<string>();
  const commands: LayoutCommand[] = [];
  const heldCommands: LayoutCommand[] = [];
  const paneIds: Record<string, string> = {};
  const cwds: Record<string, string> = {};

  const tree = withoutEmptyPanels(source.panelTree, source);
  if (!tree) return { commands, heldCommands, paneIds, cwds };

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
      if (!sourceId || held.has(sourceId)) return;
      const lastCwd = paneSessions[sourceId]?.lastCwd;
      const mapped = lastCwd ? mapUnderRoot(lastCwd, sourceRoot, targetRoot) : null;
      if (mapped && mapped !== trimSeparator(targetRoot)) cwds[node.paneId] = mapped;
    };
    walk(rootNode);
    return { id: newTabId(), title: tab.title, rootNode: remapLeaves(rootNode) };
  };

  const freshTabs = new Map<string, Tab>();
  for (const panel of Object.values(source.panels)) {
    for (const tab of panel.tabs) freshTabs.set(tab.id, fresh(tab));
  }
  const isHeld = (tab: Tab) => allPaneIds(tab.rootNode).some((id) => held.has(id));

  const replaced = replaceableTab(target);
  const firstPanel = target ? allPanelIds(target.layout.panelTree)[0] : TARGET_FIRST_PANEL;

  // Which target panel each source panel becomes, and the tab it was opened
  // with: a new panel needs one (`split-panel-with-new-tab`), and so does a
  // target with no layout (the first `new-tab`). The first tab the
  // restore may open, or else a placeholder the held batch closes.
  const panelOf = new Map<string, string>();
  const seeded = new Map<string, Tab>();
  const placeholders = new Map<string, Tab>();
  const seedOf = (sourcePanelId: string): Tab => {
    const open = source.panels[sourcePanelId].tabs.find((t) => !isHeld(t));
    if (open) {
      const tab = freshTabs.get(open.id)!;
      seeded.set(sourcePanelId, tab);
      return tab;
    }
    const placeholder: Tab = {
      id: newTabId(),
      title: DEFAULT_TAB_TITLE,
      rootNode: { type: "leaf", paneId: newPaneId() },
    };
    placeholders.set(sourcePanelId, placeholder);
    return placeholder;
  };

  // No layout yet: the first tab is what makes the target's first panel.
  if (!target) {
    commands.push({ type: "new-tab", tab: seedOf(firstLeaf(tree)), select: false });
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
    const opened = newPanelId();
    commands.push({
      type: "split-panel-with-new-tab",
      tab: seedOf(firstLeaf(node.second)),
      direction: node.direction,
      newPanelId: opened,
      sourcePanelId: at,
    });
    commands.push({ type: "update-panel-ratio", firstPanelId: at, ratio: node.ratio });
    build(node.first, at);
    build(node.second, opened);
  };
  build(tree, firstPanel);

  const firstSourcePanel = firstLeaf(tree);
  /** The target's own tabs, in the panel the source's first lands in. */
  const kept = target
    ? (target.layout.panels[firstPanel]?.tabs ?? []).filter((t) => t.id !== replaced)
    : [];
  const keptPinned = new Set(target?.layout.panels[firstPanel]?.pinnedTabIds ?? []);
  let replacedClosed = !replaced;

  for (const sourcePanelId of allPanelIds(tree)) {
    const panel = source.panels[sourcePanelId];
    const at = panelOf.get(sourcePanelId)!;
    const seed = seeded.get(sourcePanelId);
    const pinned = new Set(panel.pinnedTabIds);
    let opened = seed !== undefined;

    // The restore: every tab without a held pane. Pinning moves a tab to
    // the end of the pinned block, so pinned in pin order they line up as
    // they were.
    for (const tab of panel.tabs) {
      const made = freshTabs.get(tab.id)!;
      if (made === seed || isHeld(tab)) continue;
      commands.push({ type: "new-tab", tab: made, panelId: at, select: false });
      opened = true;
    }
    for (const tabId of panel.pinnedTabIds) {
      const tab = panel.tabs.find((t) => t.id === tabId);
      if (tab && !isHeld(tab)) commands.push({ type: "toggle-pin-tab", tabId: freshTabs.get(tabId)!.id });
    }
    const isFirst = sourcePanelId === firstSourcePanel;
    if (isFirst && opened && !replacedClosed) {
      commands.push({ type: "close-tab", tabId: replaced! });
      replacedClosed = true;
    }

    // The held batch: the rest, then the order put back.
    const heldTabs = panel.tabs.filter(isHeld);
    if (heldTabs.length === 0) continue;
    for (const tab of heldTabs) {
      heldCommands.push({ type: "new-tab", tab: freshTabs.get(tab.id)!, panelId: at, select: false });
    }
    for (const tab of heldTabs) {
      if (pinned.has(tab.id)) heldCommands.push({ type: "toggle-pin-tab", tabId: freshTabs.get(tab.id)!.id });
    }
    const placeholder = placeholders.get(sourcePanelId);
    if (placeholder) heldCommands.push({ type: "close-tab", tabId: placeholder.id });
    if (isFirst && !replacedClosed) {
      heldCommands.push({ type: "close-tab", tabId: replaced! });
      replacedClosed = true;
    }
    const mine = isFirst ? kept : [];
    const ordered = [
      ...mine.filter((t) => keptPinned.has(t.id)).map((t) => t.id),
      ...panel.tabs.filter((t) => pinned.has(t.id)).map((t) => freshTabs.get(t.id)!.id),
      ...mine.filter((t) => !keptPinned.has(t.id)).map((t) => t.id),
      ...panel.tabs.filter((t) => !pinned.has(t.id)).map((t) => freshTabs.get(t.id)!.id),
    ];
    heldCommands.push({ type: "reorder-tabs", panelId: at, tabIds: ordered });
  }

  return { commands, heldCommands, paneIds, cwds };
}
