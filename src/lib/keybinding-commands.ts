import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { usePreferencesStore } from "../store/preferences-store";
import { useKeybindingsStore } from "../store/keybindings-store";
import { useToastStore } from "../store/toast-store";
import { getBrowserPaneRef } from "./browser-pane-registry";
import type { BrowserPaneRef } from "../components/workspace-panes/BrowserPane/BrowserPane";
import { DEFAULT_AGENT_COMMAND } from "../agent-defaults";
import { isHomePath, homeLaunchCommand } from "./home";
import { comboFromEvent, comboMatches } from "./keybindings";

/**
 * Keybinding commands that are meaningful in ANY window — the primary window
 * and the detached popup windows of ADR-156 alike.
 *
 * Both renderers (`App` and `DetachedApp`) mount their own global key handler,
 * so anything defined only in `App` is silently dead in a popout. Keeping the
 * window-agnostic half here is what stops the two from drifting: a popout gets
 * new tab / new agent / new browser / pane / panel / browser commands for free,
 * and `App` layers the primary-only commands (settings, command palette,
 * sidebar, new workspace, navigation history) on top.
 *
 * Every handler reads from `getState()` rather than React state so the map can
 * be built once, outside the render cycle.
 */

/** The focused pane's browser ref, or undefined when the focus isn't a browser. */
export function getFocusedBrowserRef(): BrowserPaneRef | undefined {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
  if (!layout) return;
  const panel = layout.panels[layout.activePanelId];
  if (!panel) return;
  const tab = panel.tabs.find((t) => t.id === panel.selectedTabId);
  if (!tab) return;
  const focusedPaneId = tab.focusedPaneId;
  if (!focusedPaneId) return;
  if (state.paneContentType[focusedPaneId] !== "browser") return;
  return getBrowserPaneRef(focusedPaneId);
}

/**
 * The agent launch command for a surface. Home has no owning project and boots
 * the configured home harness; a project workspace uses its `agentCommand`.
 */
export function resolveWorkspaceCommand(workspacePath: string | null): string {
  const { preferences } = usePreferencesStore.getState();
  if (isHomePath(workspacePath)) {
    return homeLaunchCommand({
      homeHarness: preferences.homeHarness,
      homeCustomCommand: preferences.homeCustomCommand,
      homeCustomInterrupt: preferences.homeCustomInterrupt,
    });
  }
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.workspaces.some((w) => w.path === workspacePath));
  return project?.agentCommand ?? DEFAULT_AGENT_COMMAND;
}

/**
 * Open a new agent tab in the active surface.
 *
 * `prewarm` consumes the background-warmed session for a near-instant start.
 * Only the primary window may do that: the prewarmed session's cwd tracks the
 * PRIMARY window's active workspace, so a popout sitting on a different
 * workspace would inherit the wrong directory. Popouts pay the cold start.
 */
export async function startNewAgent(
  { prewarm }: { prewarm: boolean } = { prewarm: false },
): Promise<void> {
  const activeWorkspacePath = useAppStore.getState().activeWorkspacePath;
  const command = resolveWorkspaceCommand(activeWorkspacePath);
  const prewarmed = prewarm
    ? await window.electronAPI.pty.consumePrewarmed()
    : null;
  if (activeWorkspacePath && !prewarmed?.commandInjected) {
    useAppStore
      .getState()
      .setPendingStartupCommand(activeWorkspacePath, command);
  }
  useAppStore.getState().addTab(prewarmed?.paneId);
}

/** Build the window-agnostic half of the command→action map. */
export function createSharedKeybindingHandlers(
  { prewarmNewAgent }: { prewarmNewAgent: boolean } = { prewarmNewAgent: false },
): Record<string, () => void> {
  const store = () => useAppStore.getState();
  return {
    "new-tab": () => store().addTab(),
    "new-agent": () => void startNewAgent({ prewarm: prewarmNewAgent }),
    "new-browser": () => store().addBrowserTab("about:blank"),
    "split-h": () => store().splitPane("horizontal"),
    "split-v": () => store().splitPane("vertical"),
    "close-pane": () => store().requestClosePane(),
    "reopen-pane": () => store().reopenClosedPane(),
    "close-tab": () => {
      const state = store();
      const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
      const panel = layout?.panels[layout.activePanelId];
      if (panel?.selectedTabId) state.requestCloseTab(panel.selectedTabId);
    },
    "next-tab": () => store().selectNextTab(),
    "prev-tab": () => store().selectPrevTab(),
    "next-pane": () => store().focusNextPane(),
    "prev-pane": () => store().focusPrevPane(),
    "copy-branch": () => {
      const awp = store().activeWorkspacePath;
      const proj = useProjectStore
        .getState()
        .projects.find((p) => p.workspaces.some((w) => w.path === awp));
      const branch = proj?.workspaces.find((w) => w.path === awp)?.branch;
      if (branch) {
        navigator.clipboard.writeText(branch);
        useToastStore.getState().addToast({
          id: `copy-branch-${Date.now()}`,
          message: `Copied "${branch}"`,
          status: "success",
        });
      }
    },
    "split-panel-right": () => store().splitPanel("horizontal"),
    "split-panel-down": () => store().splitPanel("vertical"),
    "focus-next-panel": () => store().focusNextPanel(),
    "focus-prev-panel": () => store().focusPrevPanel(),
    "close-panel": () => {
      const state = store();
      const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
      if (!layout) return;
      state.closePanel(layout.activePanelId);
    },
    "move-tab-to-next-panel": () => {
      const state = store();
      const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
      if (!layout) return;
      const panel = layout.panels[layout.activePanelId];
      if (!panel) return;
      const panelIds = Object.keys(layout.panels);
      if (panelIds.length < 2) return;
      const idx = panelIds.indexOf(layout.activePanelId);
      const nextId = panelIds[(idx + 1) % panelIds.length];
      state.moveTabToPanel(panel.selectedTabId, nextId);
    },
    "browser-zoom-in": () => getFocusedBrowserRef()?.zoomIn(),
    "browser-zoom-out": () => getFocusedBrowserRef()?.zoomOut(),
    "browser-zoom-reset": () => getFocusedBrowserRef()?.zoomReset(),
    "browser-reload": () => getFocusedBrowserRef()?.reload(),
    "browser-focus-url": () => {
      const state = store();
      const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
      const panel = layout?.panels[layout.activePanelId];
      if (!panel) return;
      const tab = panel.tabs.find((t) => t.id === panel.selectedTabId);
      const focusedPaneId = tab?.focusedPaneId;
      if (
        !focusedPaneId ||
        state.paneContentType[focusedPaneId] !== "browser"
      ) {
        return;
      }
      const input = document.querySelector<HTMLInputElement>(
        `[data-pane-url-input="${focusedPaneId}"]`,
      );
      input?.focus();
      input?.select();
    },
    "open-diff": () => {
      const { diffOpensInNewPanel } = usePreferencesStore.getState().preferences;
      if (diffOpensInNewPanel) store().openDiffInNewPanel();
      else store().openOrFocusDiff();
    },
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `select-tab-${i + 1}`,
        () => store().selectTabByGlobalIndex(i),
      ]),
    ),
  };
}

/**
 * Match a keydown against the user's bindings and run the bound handler.
 *
 * Browser commands are conditional — they only fire when the focused pane is a
 * browser. When no browser is focused the match is skipped entirely so the
 * event reaches the native menu (app zoom) or the terminal unimpeded.
 */
export function dispatchKeybinding(
  e: KeyboardEvent,
  handlers: Record<string, () => void>,
): void {
  // Skip plain keys with no modifier — custom bindings always use at least one
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return;

  const combo = comboFromEvent(e);
  const bindings = useKeybindingsStore.getState().bindings;

  for (const [commandId, boundCombo] of Object.entries(bindings)) {
    if (!comboMatches(combo, boundCombo)) continue;
    const handler = handlers[commandId];
    if (commandId.startsWith("browser-")) {
      if (!handler || !getFocusedBrowserRef()) continue;
      e.preventDefault();
      handler();
      return;
    }
    // A command this window doesn't implement (a primary-only command seen in a
    // popout, or one handled deeper in the tree like `terminal-search`) must not
    // be swallowed — keep scanning, then let the event reach its real handler.
    if (!handler) continue;
    e.preventDefault();
    handler();
    return;
  }
}
