import type { PrComment } from "./lib/pr-info";
import type { HostId } from "./lib/hosts";
import type { BridgeApi } from "../electron/bridge/contract";
import type { InvokeFrame, ResultFrame } from "../electron/bridge/types";
import type { NativeApi } from "../electron/preload";

export interface AppPreferences {
  dockBadgeEnabled: boolean;
  notifyOnResponse: boolean;
  notifyOnRequiresInput: boolean;
  notifyOnPrComment: boolean;
  /** Comment notifications from GitHub Apps (`github-actions`, Dependabot, …). */
  notifyOnBotPrComments: boolean;
  /** Comment notifications for comments you wrote yourself. */
  notifyOnOwnPrComments: boolean;
  notifyOnPrApproved: boolean;
  notifyOnPrChangesRequested: boolean;
  notifyOnPrChecksFailed: boolean;
  notificationSound: string | false;
  defaultEditor: string;
  editorIsTerminal: boolean;
  diffOpensInNewPanel: boolean;
  /** Days to retain non-active agents. Set to 0 to disable pruning. */
  agentRetentionDays: number;
  /** True after the one-time prune notice has been shown to the user. */
  agentPruneNoticeShown: boolean;
  /** ADR-168's usage-stats collection kill switch. */
  statsEnabled: boolean;
  /** ADR-211: whether the New Workspace dialog asks Jev for a folder. */
  folderSuggestionsEnabled: boolean;
  /** ADR-212: the earned title shown in the trophy room; null means the latest earned. */
  achievementTitle: string | null;
  /** ADR-212: secret badge ids the user chose to reveal. */
  revealedBadges: string[];
}

export type AgentLifecycleStatus =
  | "active"
  | "completed"
  | "error"
  | "abandoned";

export interface AgentInfo {
  id: string;
  agentSessionId: string;
  name: string | null;
  status: AgentLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  activatedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  /** The host the agent's terminal runs on (ADR-191 §5). */
  hostId: HostId;
  workspacePath: string | null;
  cwd: string;
  agentKind: AgentKind;
  agentCommand: string | null;
  paneId: string | null;
  lastAgentStatus: string | null;
  /** ISO timestamp set when auto-resume fires for this agent, to prevent double-launch */
  resumedAt: string | null;
  /**
   * True when the user renamed this agent by hand. A pinned `name` wins over
   * the live terminal title and is never overwritten by the title sync.
   */
  namePinned?: boolean;
}

/**
 * ADR-162's durable notification log. Mirrors `NotificationRecord` in
 * `electron/notification-store.ts`; the derived bridge contract fails the
 * build wherever the host's copy stops fitting this one.
 */
export type NotificationKind =
  | "agent-responded"
  | "agent-requires-input"
  | "pr-comment"
  | "pr-approved"
  | "pr-changes-requested"
  | "pr-checks-failed"
  | "badge-unlocked";

export type NotificationTarget =
  | { type: "agent"; agentId: string }
  | { type: "url"; url: string }
  /** The trophy room; `badgeId` opens the Badges tab on that badge's track. */
  | { type: "stats"; badgeId?: string };

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** ISO timestamp. */
  timestamp: string;
  read: boolean;
  target: NotificationTarget | null;
  /** `pr-comment` records only, and only when the fetcher knew it (#177). */
  comment?: PrComment;
}

/**
 * ADR-168's usage stats. Mirrors the corresponding types in
 * `electron/stats-store.ts`; the derived bridge contract fails the build
 * wherever the host's copy stops fitting this one.
 */
export type StatCounter =
  | "prompts"
  | "toolCalls"
  | "agentSessions"
  | "subagents"
  | "agentsResponded"
  | "agentsKilled"
  | "agentsKilledMidThought"
  | "blocks"
  | "unblocks"
  | "unblockMsTotal"
  | "fastUnblocks"
  | "worktreesCreated"
  | "worktreesRemoved"
  | "worktreesMerged"
  | "prsMerged"
  | "prApproved"
  | "prChangesRequested"
  | "prChecksFailed";

/** Gauges aggregate with max(), not sum(). */
export type StatGauge = "maxConcurrentAgents";

export type DayBucket = Partial<Record<StatCounter | StatGauge, number>>;

/** One retained day's prompt count, for the contribution graph. */
export interface DailyPrompts {
  /** Local YYYY-MM-DD. */
  day: string;
  count: number;
}

export interface StatsSummary {
  today: DayBucket;
  last7Days: DayBucket;
  allTime: DayBucket;
  /** Consecutive local weeks (Monday to Sunday) with at least one prompt. */
  streakWeeks: number;
  /** Prompt count per local day, oldest first, for days that recorded one. */
  dailyPrompts: DailyPrompts[];
  /** PRs merged per local day: last 7 days, oldest first, zeros included. */
  dailyPrsMerged: { day: string; count: number }[];
  /** badgeId -> ISO awarded-at. */
  badges: Record<string, string>;
  enabled: boolean;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearAssociation {
  teamId: string;
  teamName: string;
  teamKey: string;
}

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  priority: number;
  priorityLabel?: string;
  state: { name: string; type: string; color?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  createdAt?: string;
  dueDate?: string | null;
  estimate?: number | null;
  assignee?: { name: string; displayName?: string } | null;
  project?: { name: string } | null;
  cycle?: { number: number; name?: string | null } | null;
  team?: { key: string; name: string } | null;
  creator?: { name: string; displayName?: string } | null;
}

export interface LinearIssueDetail extends LinearIssue {
  description: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
  assignee: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  updatedAt: string;
  author: { login: string };
  createdAt?: string;
  closedAt?: string | null;
  milestone?: { title: string } | null;
  commentCount?: number;
  stateReason?: string | null;
  projectItems?: { title: string; status?: string }[];
}

export interface GitHubRepo {
  nameWithOwner: string;
  description: string | null;
  private: boolean;
  sshUrl: string;
  httpsUrl: string;
  pushedAt: string | null;
  cloneUrl: string;
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string | null;
  milestone: { title: string } | null;
}

export interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
  hostname: string | null;
  /** The host the port is listening on — `"local"` for this machine. */
  hostId: string;
  /** `"::1"` when listened on only at the IPv6 loopback. */
  loopbackHost?: "::1";
}

export interface ManorProcessInfo {
  daemon: {
    pid: number | null;
    alive: boolean;
  };
  internalServers: Array<{
    name: string;
    port: number | null;
  }>;
  sessions: Array<{
    sessionId: string;
    alive: boolean;
    cwd: string | null;
    /** True when the session is alive in the daemon but has no matching pane in the layout */
    orphaned: boolean;
  }>;
  ports: ActivePort[];
}

export type AgentKind = "claude" | "opencode" | "codex" | "pi";

/**
 * The one live state shown for an Agent's pane (ADR-184). There is no
 * `"complete"`: a finished turn is `responded`, an ended session is `idle`
 * (and the Agent's lifecycle becomes `completed`). The single declaration —
 * `electron/terminal-host/types.ts` and the reconciler mirror or import it,
 * since electron and the renderer sit in separate tsconfigs.
 */
export type AgentStatus =
  | "idle"
  | "thinking"
  | "working"
  | "requires_input"
  | "error"
  | "responded";

/**
 * One pane's Agent status as main's Status reconciler publishes it on the
 * `agent-status` channel (ADR-184 §4). `reason` says why.
 */
export interface PaneAgentStatusUpdate {
  paneId: string;
  status: AgentStatus;
  reason: string;
  kind: AgentKind | null;
}

/**
 * The renderer's per-pane cache of `PaneAgentStatusUpdate` — the map key
 * already carries `paneId`, so it is dropped here. The renderer displays this
 * exactly as published; it never re-derives it (ADR-184 §4).
 */
export type PaneAgentStatus = Omit<PaneAgentStatusUpdate, "paneId">;

/**
 * ADR-199's persistent Agent activity history. Mirrors the types in
 * `electron/agent-activity-store.ts`; declared here rather than imported so
 * the renderer's declaration surface stays self-contained.
 */
export interface AgentActivityTransition {
  status: AgentStatus;
  /** Epoch ms, main's clock. */
  at: number;
}

/** Refreshed on each record, so a deleted Agent's lane can still be named. */
export interface AgentActivityMeta {
  name: string | null;
  projectId: string | null;
  workspacePath: string | null;
  hostId: string;
}

export interface AgentActivityEntry {
  meta: AgentActivityMeta;
  /** Oldest first. Consecutive entries never share a status. */
  transitions: AgentActivityTransition[];
}

/** A span Manor was running; gaps between sessions were not observed. */
export interface AgentActivitySession {
  start: number;
  end: number;
}

export interface AgentActivitySnapshot {
  /** Keyed by Agent id. Up to 24h of history. */
  agents: Record<string, AgentActivityEntry>;
  /** Oldest first; the last one is the running app, ending at `now`. */
  sessions: AgentActivitySession[];
  now: number;
}

/**
 * Position in a session's PTY output stream (mirrored from
 * electron/terminal-host/types.ts). Optional wherever it crosses the boundary:
 * the daemon outlives the app, so a daemon predating ADR-159 reports none.
 */
export type StreamPosition = number;

/** Options for `pty.create` (one type for main and renderer). */
export interface PtyCreateOptions {
  /** Sets `MANOR_AGENT_KIND` in a freshly spawned session's env. */
  agentKind?: string | null;
  /**
   * The host a new session runs on: the host of the workspace the pane
   * belongs to. Omitted, main guesses it from the cwd (local wins a path
   * both hosts have). An existing session stays where it runs.
   */
  hostId?: HostId;
}

/** Options for `pty.reset`: the host its fresh session runs on (see `PtyCreateOptions`). */
export type PtyResetOptions = Pick<PtyCreateOptions, "hostId">;

/**
 * The winsize half of a create-shaped PTY reply (`pty.create`, `pty.reset`).
 *
 * The last three fields are the host's answer to "who owns the winsize"
 * (ADR-178 D5). **Absent means this viewer owns it**, which is what a viewer
 * alone on a pane is told and what every desktop pane was told until ADR-180
 * ticket 5 put both platforms on the same handler. A viewer told
 * `winsizeOwner: false` is a follower — it renders the `cols×rows` here and
 * never asks the pty for a different pair — and since D6 that can be a second
 * desktop window as readily as a browser.
 */
export interface PtyWinsize {
  /** False when another viewer — the desktop app — owns the winsize. */
  winsizeOwner?: boolean;
  /** The winsize owner's grid, to be rendered as-is. */
  cols?: number;
  rows?: number;
}

/** What `pty.create` resolves to (ADR-183: one type for main and renderer). */
export type PtyCreateResult = PtyWinsize & (
  | {
      ok: true;
      /**
       * The host the session actually runs on (ADR-160) — not its project's
       * current host, which may have changed since.
       */
      hostId: string;
      /** The session's screen when it already existed; null for a fresh one. */
      snapshot: string | null;
      /** Stream position the snapshot reflects (ADR-159). */
      snapshotSeq?: StreamPosition;
      /** The session already existed — NOT that its shell reached a prompt. */
      prewarmed: boolean;
    }
  | {
      /**
       * The pane's remote host is not connected (ADR-178 §6): not a broken
       * terminal — it is created once `hostId` is back.
       */
      ok: false;
      reason: "host-unavailable";
      hostId: string;
      error: string;
    }
  | { ok: false; reason: "error"; error: string }
);

export type { PushProgressEvent } from "../electron/bridge/handlers/branches-diffs";

/** What `terminal.pasteClipboardImage` resolves to (ADR-187 §3). */
export type PasteClipboardImageResult =
  | { kind: "local" }
  | { kind: "none" }
  | { kind: "uploaded"; path: string }
  | { kind: "error"; message: string };

/**
 * A live winsize-ownership change (ADR-179 D6), pushed to every viewer of
 * `paneId` whenever `pty-attachments.ts` decides the owner moved — not only
 * on this viewer's own `pty.create`/`pty.reset`. `owner` is this viewer's
 * answer, the same field `PtyCreateResult.winsizeOwner` carries, just not
 * inverted: `true` here means *this* viewer owns it now.
 */
export interface WinsizeOwnerEvent {
  paneId: string;
  cols: number;
  rows: number;
  owner: boolean;
}

/**
 * The layout wire (ADR-179 D1/D3), defined once for the Manor server and
 * every renderer in `./lib/layout/protocol.ts`.
 */
export type {
  LayoutApplyResult,
  LayoutChangedPayload,
  LayoutEntry,
  LayoutPaneTitlePayload,
  PersistedDefaultViewport,
  PersistedPaneSession,
  PersistedViewportFile,
} from "./lib/layout/protocol";

/** The one-click project transfer's wire types (ADR-213). */
export type {
  TransferInputReason,
  TransferMode,
  TransferPlan,
  TransferResult,
} from "../electron/projects/types";

/** A detached window's hold on a tab (ADR-179 D4). */
export type LayoutClaim = import("./lib/layout/visible-tabs").LayoutClaim;

/**
 * What a renderer knows before it can ask anything: answered synchronously,
 * off the preload's argv or the socket's hello, never a round trip.
 */
export interface HostFacts {
  /**
   * Which transport the client in the page is built over (ADR-180 D3): the
   * preload's IPC channels, or a WebSocket to a host. Read it to hide what a
   * browser genuinely cannot do — never to guess at a capability the bridge
   * can report.
   *
   * What that is, exactly, is `electron/ipc/`'s six survivors (D8, ticket
   * 11): `<webview>` panes and their pickers, detach-to-window, the native
   * app menu, native dialogs, the shell escape hatches, the clipboard and the
   * updater. Everything else answers the same way on both platforms, which
   * is the whole point of the handler table this `platform` check is an
   * exception to.
   */
  platform: "electron" | "web";

  /**
   * This renderer's id, as the Manor server names it in a command's origin
   * (ADR-179 D3): the desktop's `webContents.id`, a browser's bridge
   * connection id. Null in a browser until the socket has said hello.
   *
   * Its one job is telling a renderer's own `layout.changed` from everybody
   * else's, so a command's selection hint lands only on the window that sent
   * it.
   */
  rendererId: string | null;

  env: {
    isPackaged: boolean;
  };

  /**
   * The one tab this window holds of the shared layout (ADR-179 D4), from
   * `--manor-claim=<tabId>::<workspacePath>`. Null in the primary window and
   * in a browser — a claim is a desktop window's, and a browser always sees
   * the whole workspace. Main knows it too, and the window's viewport reports
   * are what make it take effect on the server; the tab itself never leaves
   * the workspace.
   *
   * It is also the whole of what makes a window a detached one (ADR-182 D5):
   * a window is detached exactly when it holds a claim.
   */
  claim: { workspacePath: string; tabId: string } | null;
}

/**
 * `window.electronAPI`, the one surface the desktop renderer and a browser
 * tab both call (ADR-180 D3, ADR-182 D4).
 *
 * Built from its parts rather than written out:
 *
 * - `HostFacts` above — the synchronous facts;
 * - `NativeApi` — what the preload answers in process, desktop only
 *   (`nativeApi` in `electron/preload.ts`);
 * - `BridgeApi` — every handler on the table and every listener in
 *   `SUBSCRIPTIONS` (`electron/bridge/events.ts`), each with the signature
 *   its handler or event declares (`electron/bridge/contract.ts`).
 *
 * So a method's signature is written once, where it is implemented, and
 * every caller in `src/` is type-checked against that. `electron/bridge/surface.ts`
 * checks what derivation cannot: that every method has an answer in a
 * browser, and that the table's rules agree with each other.
 */
export type ElectronAPI = HostFacts & NativeApi & BridgeApi;

export interface PickedElementResult {
  outerHTML: string;
  selector: string;
  computedStyles: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
  accessibility: Record<string, string>;
  reactComponents?: Array<{
    name: string;
    source?: { fileName: string; lineNumber: number };
  }>;
}

// ── Remote control (ADR-161) ──

/**
 * The Manor relay's connection (ADR-206). Mirrors `RelayStatus` in
 * `electron/remote-control/relay/connector.ts`. `error` is set in `failed`,
 * and also while `starting` when a previous attempt to reach the relay
 * failed and the connector is retrying.
 */
export interface RelayStatus {
  state: "stopped" | "starting" | "running" | "failed";
  url: string | null;
  error: string | null;
}

export interface RemoteDeviceInfo {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** Whether the device has a live Web Push subscription. */
  hasPush: boolean;
}

export interface RemoteControlStatus {
  enabled: boolean;
  devices: RemoteDeviceInfo[];
  relay: RelayStatus;
  /** Where pairing links point; null when nothing can be paired. */
  relayOrigin: string | null;
  /** The web app on the relay, without credentials; null when `relayOrigin` is. */
  relayAppUrl: string | null;
  encryptionAvailable: boolean;
  /** Open relay channels: every live remote connection there is. */
  relayViewers: number;
  /** A relay notice that is not a connection state (identity replaced). */
  relayNotice: string | null;
}

export interface RemotePairResult {
  device: RemoteDeviceInfo;
  /** Shown once. Never retrievable again. */
  rawToken: string;
  /** The relay link the device opens (ADR-206). */
  pairingUrl: string;
}

// ── The host surface (ADR-180 D3) ──

/**
 * What the preload exposes, and the only thing it exposes: the facts a
 * renderer needs before it can ask anything, one way to call the host's
 * handler table, one way to listen to it, and the namespaces the preload
 * still answers itself.
 *
 * `window.electronAPI` is *built over this*, in the page, by
 * `src/bridge/client.ts`: `contextBridge` copies the shape it is handed, and
 * the `Proxy` that turns `ns.method(...)` into an invoke has no members to
 * copy. Undefined in a browser, where the same client runs over a WebSocket
 * instead and nothing has a preload under it.
 */
export interface ManorHost {
  /** Always `electron`. A browser has no `manorHost` at all. */
  platform: "electron";
  /** This window's `webContents.id`, as `ElectronAPI.rendererId` documents. */
  rendererId: string | null;
  claim: { workspacePath: string; tabId: string } | null;
  env: { isPackaged: boolean };
  /**
   * The namespaces the preload answers in process — `webview`, `window`,
   * `menu`, `dialog`, `shell`, `clipboard`, `updater`, the set that can never
   * leave it. The client calls straight through to these and reaches
   * `invoke` only for what is not here.
   */
  native: NativeApi;
  /**
   * Send one invoke frame to the host. Resolves with its `ResultFrame` —
   * failures included, as data rather than a rejection, because
   * `ipcMain.handle` drops the `code` off a thrown error. The client settles
   * it the same way it settles a frame off the socket.
   */
  invoke: (frame: InvokeFrame) => Promise<ResultFrame>;
  /**
   * Hear `ns.event`, for one `key` (a paneId) or for every key when null.
   * Returns the unsubscribe. Reference-counted in the preload, so two
   * subscriptions to the same thing are two subscriptions.
   */
  subscribe: (
    ns: string,
    event: string,
    key: string | null,
    callback: (...args: unknown[]) => void,
  ) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    /** ADR-180 D3. Undefined in a browser. */
    manorHost: ManorHost | undefined;
  }
}
