import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  selectSelectedTabId,
} from "../store/app-store";
import {
  useProjectStore,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../store/project-store";
import { usePreferencesStore } from "../store/preferences-store";
import { useKeybindingsStore } from "../store/keybindings-store";
import { useToastStore } from "../store/toast-store";
import { getBrowserPaneRef } from "./browser-pane-registry";
import type { BrowserPaneRef } from "../components/workspace-panes/BrowserPane/BrowserPane";
import { DEFAULT_AGENT_COMMAND } from "../agent-defaults";
import { isHomePath, homeLaunchCommand } from "./home";
import {
  PAGE_BROWSER_COMMANDS,
  comboFromEvent,
  commandsForCombo,
} from "./keybindings";
import { cycleRegion, focusRegion } from "./focus-regions";
import { requestUi } from "../utils/ui-request";
import type { ForwardedCommandPayload } from "./menu-commands";
import {
  commandHandlers,
  type CommandHandler,
  type SharedCommandContext,
} from "./commands";
import { findPanelWithTab } from "./layout/workspace-layout";
import { isWebApp } from "./platform";

/**
 * The renderer half of the command table (`commands.ts`) for commands that
 * are meaningful in ANY window — the primary window and the detached popup
 * windows of ADR-156 alike — plus the key dispatcher both kinds of window use.
 *
 * Every window runs `App` (ADR-179 D4), but a detached one withholds the
 * primary-only handlers and forwards those combos to the primary window
 * instead — so what the shared context backs is what a popout can actually
 * run: new tab / new agent / new browser / pane / panel / browser commands,
 * with settings, the command palette, the sidebar, new workspace and
 * navigation history layered on (`menu-handlers.ts`) only where there is
 * chrome for them.
 */

/** The focused pane's id when that pane is a browser, else undefined. */
function focusedBrowserPaneId(): string | undefined {
  const state = useAppStore.getState();
  const focusedPaneId = selectFocusedPaneOfActiveTab(state);
  if (!focusedPaneId) return;
  if (selectPaneContentType(state, focusedPaneId) !== "browser") return;
  return focusedPaneId;
}

/** The focused pane's browser ref, or undefined when the focus isn't a browser. */
export function getFocusedBrowserRef(): BrowserPaneRef | undefined {
  const paneId = focusedBrowserPaneId();
  return paneId ? getBrowserPaneRef(paneId) : undefined;
}

/**
 * True while DOM focus sits inside the focused browser pane's own chrome — its
 * URL bar, find bar or toolbar. There the browser's ⌘[ / ⌘] / ⌘F beat the
 * pane and terminal commands that share those combos.
 */
function isBrowserPaneDomFocused(): boolean {
  if (typeof document === "undefined") return false;
  const paneId = focusedBrowserPaneId();
  if (!paneId) return false;
  const active = document.activeElement as HTMLElement | null | undefined;
  const pane = active?.closest?.("[data-pane-id]");
  return pane?.getAttribute("data-pane-id") === paneId;
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
  if (!prewarmed) {
    useAppStore.getState().addTerminalTab(command, "agent-startup");
    return;
  }
  // The prewarmed session already exists, so its pane id is known before the
  // tab is: queue the launch line against it directly, and only when the
  // warm session is not already running one (ADR-179 ticket 11).
  if (!prewarmed.commandInjected) {
    await window.electronAPI.layout.setPendingCommand(
      prewarmed.paneId,
      command,
      "agent-startup",
    );
  }
  useAppStore.getState().addTab(prewarmed.paneId);
}

/**
 * Move a tab to the panel after the one holding it, wrapping — the active
 * panel's selected tab by default. The one implementation behind the
 * `move-tab-to-next-panel` command and the tab context menu's item.
 */
export function moveTabToNextPanel(tabId?: string): void {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
  if (!layout) return;
  const id = tabId ?? selectSelectedTabId(state, selectActivePanelId(state));
  if (!id) return;
  const from = findPanelWithTab(layout, id)?.panel.id;
  const panelIds = Object.keys(layout.panels);
  if (!from || panelIds.length < 2) return;
  const nextId = panelIds[(panelIds.indexOf(from) + 1) % panelIds.length];
  state.moveTabToPanel(id, nextId);
}

/** The active surface, resolved back to its owning project and workspace. */
export function activeSurface(): {
  path: string | null;
  project: ProjectInfo | null;
  workspace: WorkspaceInfo | null;
} {
  const path = useAppStore.getState().activeWorkspacePath;
  const project =
    useProjectStore
      .getState()
      .projects.find((p) => p.workspaces.some((w) => w.path === path)) ?? null;
  const workspace = project?.workspaces.find((w) => w.path === path) ?? null;
  return { path, project, workspace };
}

function copyToClipboard(text: string, label: string): void {
  void navigator.clipboard.writeText(text);
  useToastStore.getState().addToast({
    id: `${label}-${Date.now()}`,
    message: `Copied "${text}"`,
    status: "success",
  });
}

/**
 * What the command table's window-agnostic commands run against, backed by
 * the stores. Every member reads `getState()` rather than React state so the
 * context — and the handler map over it — can be built once, outside the
 * render cycle.
 */
export function createSharedCommandContext(
  { prewarmNewAgent }: { prewarmNewAgent: boolean } = { prewarmNewAgent: false },
): SharedCommandContext {
  return {
    app: () => useAppStore.getState(),
    active: activeSurface,
    activePanelId: () => selectActivePanelId(useAppStore.getState()),
    activeTabId: () => {
      const state = useAppStore.getState();
      return selectSelectedTabId(state, selectActivePanelId(state));
    },
    focusedPaneId: () => selectFocusedPaneOfActiveTab(useAppStore.getState()),
    copyToClipboard,
    startNewAgent: () => void startNewAgent({ prewarm: prewarmNewAgent }),
    moveTabToNextPanel: () => moveTabToNextPanel(),
    focusedBrowser: getFocusedBrowserRef,
    focusedBrowserPaneId,
    focusBrowserUrlBar: (paneId) => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-pane-url-input="${paneId}"]`,
      );
      input?.focus();
      input?.select();
    },
    requestUi,
    cycleRegion: (delta) => void cycleRegion(delta),
    focusRegion,
    diffOpensInNewPanel: () =>
      usePreferencesStore.getState().preferences.diffOpensInNewPanel,
  };
}

/**
 * The window-agnostic half of the command→action map: the table's
 * `scope: "any"` commands, less the native-only ones on the web.
 */
export function createSharedKeybindingHandlers(
  options: { prewarmNewAgent: boolean } = { prewarmNewAgent: false },
): Record<string, CommandHandler> {
  return commandHandlers(createSharedCommandContext(options), {
    web: isWebApp(),
    primary: false,
  });
}

/**
 * Any Radix dialog currently open in this window. Matches both the modal and
 * non-modal shapes Radix can render — `aria-modal` isn't actually emitted by
 * the installed `@radix-ui/react-dialog`, so the plain `[role="dialog"]`
 * clause is what matches in practice; the `aria-modal` clause is kept in case
 * a future upgrade starts emitting it.
 */
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"][aria-modal="true"], [role="dialog"][data-state="open"]';

/**
 * Command a dialog's own toggle keybinding still runs while it's open, keyed
 * by that dialog's `data-testid`. Everything else is left to the dialog while
 * one is open — e.g. ⌘T must not touch tabs behind an open Settings modal.
 */
const DIALOG_OWN_TOGGLE: Record<string, string> = {
  "settings-modal": "settings",
  "command-palette": "command-palette",
};

function openDialogTestId(): string | null {
  // Guard for unit tests, which run this module in a DOM-less environment.
  if (typeof document === "undefined") return null;
  return (
    document
      .querySelector<HTMLElement>(OPEN_DIALOG_SELECTOR)
      ?.getAttribute("data-testid") ?? null
  );
}

/** Whether an open dialog leaves `commandId` alone (ADR-175 modal scope). */
function blockedByDialog(commandId: string): boolean {
  const openDialog = openDialogTestId();
  return openDialog !== null && DIALOG_OWN_TOGGLE[openDialog] !== commandId;
}

export interface DispatchOptions {
  /**
   * Called for a bound command this window has no handler for. Return true
   * when it was handled elsewhere (a popout hands primary-only commands to the
   * main window), which swallows the key.
   */
  fallback?: (commandId: string) => boolean;
}

/**
 * Run the first runnable command in `commandIds`. Returns whether one ran.
 *
 * Browser commands are conditional — they only run when the focused pane is a
 * browser, so a browser combo elsewhere reaches the native menu (app zoom) or
 * the terminal unimpeded.
 */
function runFirst(
  commandIds: string[],
  handlers: Record<string, () => void>,
  options: DispatchOptions,
): boolean {
  for (const commandId of commandIds) {
    const handler = handlers[commandId];
    if (commandId.startsWith("browser-")) {
      if (!handler || !getFocusedBrowserRef()) continue;
      handler();
      return true;
    }
    // A command this window doesn't implement (a primary-only command seen in
    // a popout, or one handled deeper in the tree like `terminal-search`) must
    // not be swallowed — keep scanning, then let the event reach its real
    // handler.
    if (!handler) {
      if (options.fallback?.(commandId)) return true;
      continue;
    }
    handler();
    return true;
  }
  return false;
}

/**
 * Match a keydown against the user's bindings and run the bound handler.
 *
 * Matches run in registry order, except that while DOM focus is inside the
 * focused browser pane (its URL bar, say) the browser commands go first — so
 * ⌘[ / ⌘] / ⌘F mean back / forward / find there, as they do in the page.
 *
 * While a Radix dialog is open, only that dialog's own toggle command (the one
 * that also closes it) is allowed through; every other command is left to the
 * dialog — including a bound combo the dialog doesn't otherwise handle, which
 * simply falls through to the browser/OS default instead of reaching behind
 * the modal.
 */
export function dispatchKeybinding(
  e: KeyboardEvent,
  handlers: Record<string, () => void>,
  options: DispatchOptions = {},
): void {
  let commandIds = commandsForCombo(
    comboFromEvent(e),
    useKeybindingsStore.getState().bindings,
  );
  if (commandIds.length === 0) return;

  // The first match decides whether a dialog blocks the key, as before.
  if (blockedByDialog(commandIds[0])) return;

  if (isBrowserPaneDomFocused()) {
    const browserFirst = commandIds.filter((id) =>
      PAGE_BROWSER_COMMANDS.includes(id),
    );
    commandIds = [
      ...browserFirst,
      ...commandIds.filter((id) => !browserFirst.includes(id)),
    ];
  }

  if (runFirst(commandIds, handlers, options)) e.preventDefault();
}

/** Commands that move keyboard focus somewhere in this window's chrome. */
const FOCUS_MOVING_COMMANDS = new Set([
  "focus-next-region",
  "focus-prev-region",
  "focus-sidebar",
  "focus-tabbar",
]);

/**
 * Run a command main forwarded to this window: a bound combo pressed inside a
 * web page, or a primary-only command pressed in a popout. It goes through the
 * same rules as a local key press — the modal scope, and browser commands only
 * with a browser focused.
 */
export function runForwardedCommand(
  payload: ForwardedCommandPayload,
  handlers: Record<string, () => void>,
  options: DispatchOptions = {},
): void {
  const { commandId, source } = payload;
  if (blockedByDialog(commandId)) return;

  if (source === "webview" && FOCUS_MOVING_COMMANDS.has(commandId)) {
    // The page holds the keyboard; let go of the <webview> first so focus can
    // land in the app's chrome. Region cycling then counts from the pane the
    // page lives in, which no longer holds DOM focus.
    const active =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    if (active?.tagName === "WEBVIEW") active.blur();
    if (commandId === "focus-next-region") {
      void cycleRegion(1, "pane");
      return;
    }
    if (commandId === "focus-prev-region") {
      void cycleRegion(-1, "pane");
      return;
    }
  }

  runFirst([commandId], handlers, options);
}
