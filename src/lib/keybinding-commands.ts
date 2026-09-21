import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  selectSelectedTabId,
} from "../store/app-store";
import { useProjectStore } from "../store/project-store";
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
import { commandAvailableOnWeb, type ForwardedCommandPayload } from "./menu-commands";
import { isWebApp } from "./platform";

/**
 * Keybinding commands that are meaningful in ANY window — the primary window
 * and the detached popup windows of ADR-156 alike.
 *
 * Every window runs `App` (ADR-179 D4), but a detached one withholds the
 * primary-only handlers and forwards those combos to the primary window
 * instead — so what is defined here is what a popout can actually run: new
 * tab / new agent / new browser / pane / panel / browser commands, with
 * settings, the command palette, the sidebar, new workspace and navigation
 * history layered on only where there is chrome for them.
 *
 * Every handler reads from `getState()` rather than React state so the map can
 * be built once, outside the render cycle.
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
 * Neutralize a command→action map's Electron-only entries into no-ops when
 * running as the web app (ADR-178 ticket 6): `dispatchKeybinding` and
 * `dispatchMenuCommand` both run whatever this returns, including a command a
 * user has rebound onto a key `NATIVE_ONLY_COMMANDS` never expected — so the
 * guard sits here, at the one place both dispatchers get their map, rather
 * than in each command's own body. A command absent from `commandAvailableOnWeb`
 * has nothing to do on the web (no dialog, no native menu, no detached
 * window), so it running is a silently-dropped promise rejection waiting to
 * happen, not a feature to keep working.
 */
export function guardHandlersForWeb<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends Record<string, (...args: any[]) => void>,
>(handlers: T): T {
  if (!isWebApp()) return handlers;
  const guarded: Record<string, (...args: never[]) => void> = { ...handlers };
  for (const id of Object.keys(guarded)) {
    if (!commandAvailableOnWeb(id)) guarded[id] = () => {};
  }
  return guarded as T;
}

/** Build the window-agnostic half of the command→action map. */
export function createSharedKeybindingHandlers(
  { prewarmNewAgent }: { prewarmNewAgent: boolean } = { prewarmNewAgent: false },
): Record<string, () => void> {
  const store = () => useAppStore.getState();
  return guardHandlersForWeb({
    "new-tab": () => store().addTab(),
    "new-agent": () => void startNewAgent({ prewarm: prewarmNewAgent }),
    "new-browser": () => store().addBrowserTab("about:blank"),
    "split-h": () => store().splitPane("horizontal"),
    "split-v": () => store().splitPane("vertical"),
    "close-pane": () => store().requestClosePane(),
    "reopen-pane": () => store().reopenClosedPane(),
    "close-tab": () => {
      const state = store();
      const tabId = selectSelectedTabId(state, selectActivePanelId(state));
      if (tabId) state.requestCloseTab(tabId);
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
      const panelId = selectActivePanelId(state);
      if (panelId) state.closePanel(panelId);
    },
    "move-tab-to-next-panel": () => {
      const state = store();
      const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
      const panelId = selectActivePanelId(state);
      if (!layout || !panelId) return;
      const tabId = selectSelectedTabId(state, panelId);
      if (!tabId) return;
      const panelIds = Object.keys(layout.panels);
      if (panelIds.length < 2) return;
      const idx = panelIds.indexOf(panelId);
      const nextId = panelIds[(idx + 1) % panelIds.length];
      state.moveTabToPanel(tabId, nextId);
    },
    "browser-zoom-in": () => getFocusedBrowserRef()?.zoomIn(),
    "browser-zoom-out": () => getFocusedBrowserRef()?.zoomOut(),
    "browser-zoom-reset": () => getFocusedBrowserRef()?.zoomReset(),
    "browser-reload": () => getFocusedBrowserRef()?.reload(),
    "browser-focus-url": () => {
      const state = store();
      const focusedPaneId = selectFocusedPaneOfActiveTab(state);
      if (
        !focusedPaneId ||
        selectPaneContentType(state, focusedPaneId) !== "browser"
      ) {
        return;
      }
      const input = document.querySelector<HTMLInputElement>(
        `[data-pane-url-input="${focusedPaneId}"]`,
      );
      input?.focus();
      input?.select();
    },
    "browser-back": () => getFocusedBrowserRef()?.goBack(),
    "browser-forward": () => getFocusedBrowserRef()?.goForward(),
    "browser-find": () => {
      const paneId = focusedBrowserPaneId();
      if (paneId) requestUi({ type: "pane-search", paneId });
    },
    "focus-next-region": () => void cycleRegion(1),
    "focus-prev-region": () => void cycleRegion(-1),
    "focus-tabbar": () => void focusRegion("tabbar"),
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
