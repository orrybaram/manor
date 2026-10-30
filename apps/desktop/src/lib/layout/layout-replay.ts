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
 * **A target that has it already.** A move that failed after part of its
 * replay landed is retried into the same target, and a workspace moved
 * once, then moved again onto the same host, lands in the workspace it
 * made there the first time. Neither may add a tab twice, so what the
 * target already has of the source is built on, not made again:
 * - what `previous` (the last replay of this move, `record`) made there
 *   and the target still holds, exactly;
 * - else, for a source tab nothing recorded, a target tab with the same
 *   title and pane-tree shape (`sameShape`), each claimed once. That is
 *   what holds after the app restarts, when no record is left: a re-move
 *   never duplicates a tab, at the cost that a target tab of its own that
 *   looks the same stands in for the source's. Its panel stands for the
 *   source tab's panel, so that panel is not split off again.
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
  /** What an earlier replay of the same move made in the target (see the module header). */
  previous?: ReplayRecord;
}

/** Which target tab and panel a replay made for each source tab and panel. */
export interface ReplayRecord {
  tabIds: Readonly<Record<string, string>>;
  panelIds: Readonly<Record<string, string>>;
  /** Its placeholders: one still open is closed once its panel has a tab. */
  placeholderTabIds?: readonly string[];
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
  /**
   * The target tab and panel for each source tab and panel, made now or
   * kept from `previous`. A source panel standing for the target's first
   * panel maps to `TARGET_FIRST_PANEL` while that has no id yet.
   */
  record: { tabIds: Record<string, string>; panelIds: Record<string, string> };
  /** Placeholder tabs `commands` opens and `heldCommands` closes. */
  placeholderTabIds: string[];
}

/**
 * `tabIds` in the order to send as `reorder-tabs` for `panel` as it stands:
 * those of `tabIds` it holds, in that order, then any it holds that
 * `tabIds` lacks, with every pinned tab ahead of the rest. Null when that
 * is the order already, or the panel is gone.
 */
export function currentOrder(
  layout: WorkspaceLayout,
  panelId: string,
  tabIds: readonly string[],
): string[] | null {
  const panel = layout.panels[panelId];
  if (!panel) return null;
  const present = new Set(panel.tabs.map((t) => t.id));
  const wanted = new Set(tabIds);
  const order = [
    ...tabIds.filter((id) => present.has(id)),
    ...panel.tabs.map((t) => t.id).filter((id) => !wanted.has(id)),
  ];
  const pinned = new Set(panel.pinnedTabIds);
  const sorted = [...order.filter((id) => pinned.has(id)), ...order.filter((id) => !pinned.has(id))];
  return sorted.every((id, i) => panel.tabs[i]?.id === id) ? null : sorted;
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

/**
 * Whether two pane trees look the same to a user: the same splits, each
 * the same way, and the same kind of pane (and page) at each leaf. Ids,
 * ratios and open files are not compared: they move or change.
 */
function sameShape(a: PaneNode, b: PaneNode): boolean {
  if (a.type === "leaf" || b.type === "leaf") {
    if (a.type !== "leaf" || b.type !== "leaf") return false;
    const kind = (n: typeof a) => n.contentType ?? "terminal";
    return kind(a) === kind(b) && (kind(a) !== "browser" || a.url === b.url);
  }
  return a.direction === b.direction && sameShape(a.first, b.first) && sameShape(a.second, b.second);
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
  const record = { tabIds: {} as Record<string, string>, panelIds: {} as Record<string, string> };
  const placeholderTabIds: string[] = [];
  const answer = () => ({ commands, heldCommands, paneIds, cwds, record, placeholderTabIds });

  const tree = withoutEmptyPanels(source.panelTree, source);
  if (!tree) return answer();

  // What the target already has of the source: what an earlier replay
  // made there and it still holds, else a tab of the same title and pane
  // tree (see the module header).
  const tabIds = new Map<string, string>();
  const panelIds = new Map<string, string>();
  if (target) {
    const at = new Map<string, string>();
    for (const panel of Object.values(target.layout.panels)) {
      for (const tab of panel.tabs) at.set(tab.id, panel.id);
    }
    const claimed = new Set<string>();
    const claim = (sourceTabId: string, tabId: string) => {
      tabIds.set(sourceTabId, tabId);
      claimed.add(tabId);
    };
    for (const [sourceTabId, tabId] of Object.entries(input.previous?.tabIds ?? {})) {
      if (at.has(tabId)) claim(sourceTabId, tabId);
    }
    for (const [sourcePanelId, panelId] of Object.entries(input.previous?.panelIds ?? {})) {
      if (target.layout.panels[panelId]) panelIds.set(sourcePanelId, panelId);
    }
    const targetFirst = allPanelIds(target.layout.panelTree)[0];
    for (const sourcePanelId of allPanelIds(source.panelTree)) {
      for (const tab of source.panels[sourcePanelId]?.tabs ?? []) {
        if (tabIds.has(tab.id)) continue;
        const twin = [...at.keys()].find((id) => {
          if (claimed.has(id)) return false;
          const other = target.layout.panels[at.get(id)!].tabs.find((t) => t.id === id)!;
          return other.title === tab.title && sameShape(other.rootNode, tab.rootNode);
        });
        if (!twin) continue;
        claim(tab.id, twin);
        const panelId = at.get(twin)!;
        if (!panelIds.has(sourcePanelId) && panelId !== targetFirst) panelIds.set(sourcePanelId, panelId);
      }
    }
  }
  const madeTab = (sourceTabId: string): string | null => tabIds.get(sourceTabId) ?? null;
  const madePanel = (sourcePanelId: string): string | null => panelIds.get(sourcePanelId) ?? null;

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

  /** Each source tab's target tab: the one already made, or a fresh one to send. */
  const freshTabs = new Map<string, Tab>();
  const done = new Set<string>();
  for (const panel of Object.values(source.panels)) {
    for (const tab of panel.tabs) {
      const made = madeTab(tab.id);
      if (made) done.add(tab.id);
      const next = made ? { ...tab, id: made } : fresh(tab);
      freshTabs.set(tab.id, next);
      record.tabIds[tab.id] = next.id;
    }
  }
  const idOf = (sourceTabId: string) => freshTabs.get(sourceTabId)!.id;
  const isHeld = (tab: Tab) => allPaneIds(tab.rootNode).some((id) => held.has(id));
  /** A tab the restore sends: not held, not already there. */
  const sends = (tab: Tab) => !isHeld(tab) && !done.has(tab.id);

  const lone = replaceableTab(target);
  const replaced = lone && ![...tabIds.values()].includes(lone) ? lone : null;
  const firstPanel = target ? allPanelIds(target.layout.panelTree)[0] : TARGET_FIRST_PANEL;

  // Which target panel each source panel becomes, and the tab it was opened
  // with: a new panel needs one (`split-panel-with-new-tab`), and so does a
  // target with no layout (the first `new-tab`). The first tab the
  // restore may open, or else a placeholder the held batch closes.
  const panelOf = new Map<string, string>();
  const seeded = new Map<string, Tab>();
  const placeholders = new Map<string, Tab>();
  const seedOf = (sourcePanelId: string): Tab => {
    const open = source.panels[sourcePanelId].tabs.find(sends);
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
    placeholderTabIds.push(placeholder.id);
    return placeholder;
  };

  // No layout yet: the first tab is what makes the target's first panel.
  if (!target) {
    commands.push({ type: "new-tab", tab: seedOf(firstLeaf(tree)), select: false });
  }

  // `at` is the target panel standing for `node`. A split of `at` keeps
  // `at` first and opens the second half's first panel beside it; its ratio
  // is set at once, while `at` is still that split's direct first child
  // (`update-panel-ratio` finds a split by it). A panel an earlier replay
  // opened is opened again by nobody.
  const build = (node: PanelNode, at: string) => {
    if (node.type === "leaf") {
      panelOf.set(node.panelId, at);
      record.panelIds[node.panelId] = at;
      return;
    }
    const seedPanel = firstLeaf(node.second);
    let opened = madePanel(seedPanel);
    // A half the target has every tab of already (elsewhere) needs no panel.
    const pending = allPanelIds(node.second).some((id) =>
      source.panels[id].tabs.some((t) => !done.has(t.id)),
    );
    if (!opened && !pending) {
      build(node.first, at);
      build(node.second, at);
      return;
    }
    if (!opened) {
      opened = newPanelId();
      commands.push({
        type: "split-panel-with-new-tab",
        tab: seedOf(seedPanel),
        direction: node.direction,
        newPanelId: opened,
        sourcePanelId: at,
      });
      commands.push({ type: "update-panel-ratio", firstPanelId: at, ratio: node.ratio });
    }
    build(node.first, at);
    build(node.second, opened);
  };
  build(tree, firstPanel);

  const firstSourcePanel = firstLeaf(tree);
  const ours = new Set(Object.values(record.tabIds));
  /** The target's own tabs, in the panel the source's first lands in. */
  const kept = target
    ? (target.layout.panels[firstPanel]?.tabs ?? []).filter((t) => t.id !== replaced && !ours.has(t.id))
    : [];
  const keptPinned = new Set(target?.layout.panels[firstPanel]?.pinnedTabIds ?? []);
  let replacedClosed = !replaced;

  for (const sourcePanelId of allPanelIds(tree)) {
    const panel = source.panels[sourcePanelId];
    const at = panelOf.get(sourcePanelId)!;
    const seed = seeded.get(sourcePanelId);
    const pinned = panel.pinnedTabIds.filter((id) => panel.tabs.some((t) => t.id === id));
    const isPinned = new Set(pinned);
    let opened = seed !== undefined || panel.tabs.some((t) => done.has(t.id));

    // The restore: every tab without a held pane. Pinning moves a tab to
    // the end of the pinned block, so pinned in pin order they line up as
    // they were.
    for (const tab of panel.tabs) {
      const made = freshTabs.get(tab.id)!;
      if (made === seed || !sends(tab)) continue;
      commands.push({ type: "new-tab", tab: made, panelId: at, select: false });
      opened = true;
    }
    for (const tabId of pinned) {
      const tab = panel.tabs.find((t) => t.id === tabId)!;
      if (sends(tab)) commands.push({ type: "toggle-pin-tab", tabId: idOf(tabId) });
    }
    const isFirst = sourcePanelId === firstSourcePanel;
    if (isFirst && opened && !replacedClosed) {
      commands.push({ type: "close-tab", tabId: replaced! });
      replacedClosed = true;
    }

    // The held batch: the rest, then the pins and the order put back.
    const heldTabs = panel.tabs.filter((t) => isHeld(t) && !done.has(t.id));
    if (heldTabs.length === 0) continue;
    for (const tab of heldTabs) {
      heldCommands.push({ type: "new-tab", tab: freshTabs.get(tab.id)!, panelId: at, select: false });
    }
    // A pin lands at the end of the pinned block: from the first held pin
    // on, every pin is undone and made again, in the source's order.
    const firstHeldPin = pinned.findIndex((id) => heldTabs.some((t) => t.id === id));
    if (firstHeldPin >= 0) {
      const again = pinned.slice(firstHeldPin);
      for (const tabId of again) {
        if (!heldTabs.some((t) => t.id === tabId)) heldCommands.push({ type: "toggle-pin-tab", tabId: idOf(tabId) });
      }
      for (const tabId of again) heldCommands.push({ type: "toggle-pin-tab", tabId: idOf(tabId) });
    }
    const placeholder = placeholders.get(sourcePanelId);
    if (placeholder) heldCommands.push({ type: "close-tab", tabId: placeholder.id });
    const left = target?.layout.panels[at]?.tabs ?? [];
    for (const id of input.previous?.placeholderTabIds ?? []) {
      if (left.some((t) => t.id === id)) heldCommands.push({ type: "close-tab", tabId: id });
    }
    if (isFirst && !replacedClosed) {
      heldCommands.push({ type: "close-tab", tabId: replaced! });
      replacedClosed = true;
    }
    const mine = isFirst ? kept : [];
    const ordered = [
      ...mine.filter((t) => keptPinned.has(t.id)).map((t) => t.id),
      ...panel.tabs.filter((t) => isPinned.has(t.id)).map((t) => idOf(t.id)),
      ...mine.filter((t) => !keptPinned.has(t.id)).map((t) => t.id),
      ...panel.tabs.filter((t) => !isPinned.has(t.id)).map((t) => idOf(t.id)),
    ];
    heldCommands.push({ type: "reorder-tabs", panelId: at, tabIds: ordered });
  }

  return answer();
}
