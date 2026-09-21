/**
 * Every host→renderer event, and the listener that hears it (ADR-180 D5,
 * ADR-182 D4).
 *
 * The host publishes `ns.event` (`renderer-broadcast.ts`, and the PTY stream
 * in `server.ts`); a renderer hears it through `ns.onX(cb)`, which the client
 * (`src/bridge/client.ts`) turns into a `subscribe` frame by looking the
 * listener up here. This file is the one place the three meet:
 *
 * - `BridgeEvents` names each event and the arguments it is published with,
 *   so `publishRendererBroadcast` / `publishToRenderer` and `BridgeServer`'s
 *   own publishes refuse an event nobody declared, or a payload of the wrong
 *   shape;
 * - `SUBSCRIPTIONS` pairs each listener on `ElectronAPI` with the event it
 *   hears: `./contract.ts` derives those listeners' signatures from it, and
 *   the client resolves them with it — adding a listener to the surface *is*
 *   adding a row here.
 *
 * Nothing here exists at runtime but `SUBSCRIPTIONS`, and every import is a
 * type, so the renderer bundles that read the table do not pull the main
 * process in behind it.
 */

import type {
  ActivePort,
  AgentInfo,
  AgentState,
  AppPreferences,
  NotificationRecord,
  RemoteControlStatus,
  StatsSummary,
  StreamPosition,
  WinsizeOwnerEvent,
} from "../../src/electron";
import type {
  LayoutBroadcast,
  LayoutPaneTitlePayload,
} from "../../src/lib/layout/protocol";
import type {
  ForwardedCommandPayload,
  MenuCommandPayload,
} from "../../src/lib/menu-commands";
import type { SetupProgressEvent } from "../../src/store/project-store";
import type { Theme } from "../../src/store/theme-store";
import type { AppCommand } from "../renderer-bridge";
import type { PushProgressEvent } from "./handlers/branches-diffs";

/**
 * `ns` → `event` → the arguments the event is published with, which are the
 * arguments its listener's callback is called with.
 *
 * `pty.*` are keyed by the `paneId` the stream event is about; every other
 * event is about the machine and goes to every subscriber (or, addressed, to
 * exactly one connection). `updater.*` and `menu.command` are heard only by
 * the preload's native namespaces, so they have no row in `SUBSCRIPTIONS`.
 */
export interface BridgeEvents {
  pty: {
    output: [data: string, seq?: StreamPosition];
    exit: [];
    cwd: [cwd: string];
    /** The pty reached this size, at this position in the output stream (ADR-164). */
    resized: [cols: number, rows: number];
    error: [message: string];
    agentStatus: [agent: AgentState];
    /**
     * The winsize owner changed without this viewer having made the call that
     * changed it (ADR-179 D6): another viewer outbid it, or its owner
     * disconnected and it inherited the grid.
     */
    winsizeOwner: [payload: WinsizeOwnerEvent];
  };
  layout: {
    changed: [payload: LayoutBroadcast];
    paneTitle: [payload: LayoutPaneTitlePayload];
  };
  projects: {
    changed: [];
    removeWorktreeProgress: [step: string];
    worktreeProgress: [event: SetupProgressEvent];
  };
  /**
   * The selected theme changed somewhere other than this call (ADR-179 ticket
   * 7) — `setSelected`'s own return shape, ready to apply without a round trip.
   */
  theme: { changed: [payload: { name: string; theme: Theme }] };
  ports: { changed: [ports: ActivePort[]] };
  branches: { changed: [branches: Record<string, string>] };
  diffs: {
    changed: [diffs: Record<string, { added: number; removed: number }>];
  };
  "git.push": { progress: [event: PushProgressEvent] };
  /**
   * The second argument is main's authoritative unseen flags for the agent at
   * the moment it was sent; the renderer treats them as the source of truth.
   */
  agents: {
    updated: [
      agent: AgentInfo,
      unseen: { responded: boolean; requires_input: boolean },
    ];
  };
  preferences: { changed: [prefs: AppPreferences] };
  keybindings: {
    changed: [overrides: Record<string, string>];
    /**
     * A bound combo pressed where this window's key handler can't see it — in
     * a web page, or a primary-only command pressed in a popout.
     */
    forwardedCommand: [payload: ForwardedCommandPayload];
  };
  notifications: {
    /** The full list, after every mutation (ADR-162 §3). */
    changed: [list: NotificationRecord[]];
    /** A native banner was clicked; the payload is the record id. */
    navigate: [id: string];
  };
  /** The full summary, after a burst of recording settles (ADR-168 §5). */
  stats: { changed: [summary: StatsSummary] };
  remoteControl: { status: [status: RemoteControlStatus] };
  /** A payload carrying `requestId` expects an `appCommands.result` reply. */
  appCommands: { command: [command: AppCommand] };
  updater: {
    checking: [payload: { manual: boolean }];
    updateAvailable: [info: { version: string }];
    updateDownloaded: [info: { version: string }];
    updateNotAvailable: [info: { version: string; manual: boolean }];
    downloadProgress: [
      progress: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      },
    ];
    error: [payload: { message: string; manual: boolean }];
  };
  /** A native menu item was clicked; fire-and-forget, like a keybinding. */
  menu: { command: [payload: MenuCommandPayload] };
}

/** A namespace that publishes events. */
export type EventNs = keyof BridgeEvents & string;

/** One event of a namespace. */
export type EventOf<N extends EventNs> = keyof BridgeEvents[N] & string;

/** What `ns.event` is published with. */
export type EventArgs<
  N extends EventNs,
  E extends EventOf<N>,
> = BridgeEvents[N][E] extends infer A extends unknown[] ? A : never;

/** Every event, by its wire name `ns.event`. */
export type EventName = {
  [N in EventNs]: `${N}.${EventOf<N>}`;
}[EventNs];

/** What the event with wire name `W` is published with. */
export type WireEventArgs<W extends EventName> = {
  [N in EventNs]: W extends `${N}.${infer E}`
    ? E extends EventOf<N>
      ? EventArgs<N, E>
      : never
    : never;
}[EventNs];

/**
 * Listener → the event it hears, by wire name.
 *
 * The value is what goes on the wire: the client reads it to build the
 * subscribe frame, and `src/bridge/__tests__/resolution.test.ts` asserts it
 * does for every row.
 *
 * `pty.*` are the six the daemon's stream carries plus `winsizeOwner`, and
 * are the only ones with a key (the `paneId`). Native subscriptions are *not*
 * here: `webview.*`, `updater.*` and `menu.onMenuCommand` are members of a
 * native namespace and are written in the preload.
 */
export const SUBSCRIPTIONS = {
  "pty.onOutput": "pty.output",
  "pty.onExit": "pty.exit",
  "pty.onCwd": "pty.cwd",
  "pty.onResized": "pty.resized",
  "pty.onError": "pty.error",
  "pty.onAgentStatus": "pty.agentStatus",
  "pty.onWinsizeOwner": "pty.winsizeOwner",
  "layout.onChanged": "layout.changed",
  "layout.onPaneTitle": "layout.paneTitle",
  "projects.onChanged": "projects.changed",
  "projects.onRemoveWorktreeProgress": "projects.removeWorktreeProgress",
  "projects.onWorktreeSetupProgress": "projects.worktreeProgress",
  "theme.onChanged": "theme.changed",
  "ports.onChange": "ports.changed",
  "branches.onChange": "branches.changed",
  "diffs.onChange": "diffs.changed",
  "git.push.onProgress": "git.push.progress",
  "agents.onUpdate": "agents.updated",
  "preferences.onChange": "preferences.changed",
  "keybindings.onChange": "keybindings.changed",
  "keybindings.onForwardedCommand": "keybindings.forwardedCommand",
  "notifications.onChanged": "notifications.changed",
  "notifications.onNavigate": "notifications.navigate",
  "stats.onChanged": "stats.changed",
  "remoteControl.onStatus": "remoteControl.status",
  "appCommands.onCommand": "appCommands.command",
} as const satisfies Record<string, EventName>;

/** A listener on the contract, answered by an event frame. */
export type SubscriptionMethod = keyof typeof SUBSCRIPTIONS;
