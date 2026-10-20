/**
 * What differs between the places a Manor server runs: the
 * desktop (Electron) and a remote host's headless host server. An interface
 * the composer reads, not an `if (headless)` inside it — a port the platform
 * leaves out is a feature that platform does not have.
 *
 * | Port            | Desktop                         | Host server              |
 * |-----------------|---------------------------------|--------------------------|
 * | dataDir         | `manorDataDir()`                | `~/.manor/remote/server/`|
 * | secretBox       | `electronSecretBox`             | `pickHostSecretBox()`    |
 * | daemonTransport | local socket, may restart it    | namespace `remote`, never restarts it |
 * | notifier        | dock badge and native banners   | absent: `HeadlessNotifier` |
 * | windows         | primary window, detached claims | absent                   |
 * | diffWindow      | primary window                  | absent: never paused     |
 * | remoteHosts     | SSH hosts from `projects.json`  | absent: a host has no hosts of its own |
 *
 * Type-only: nothing here runs, so it imports no Electron either.
 */

import type { AppCommandResult } from "../renderer-bridge";
import type { WindowDirectory } from "../layout/layout-store";
import type { DiffGateWindow } from "../diff-watcher";
import type { NotificationStore } from "../notification-store";
import type { ServerNotifier } from "../notifications";
import type { SecretBox } from "../platform/secret-box";
import type { PreferencesManager } from "../preferences";
import type { BroadcastBus } from "../renderer-broadcast";
import type { StatsStore } from "../stats-store";
import type { HostTransport } from "../terminal-host/transport";
import type { UnseenAgents } from "../agent-status/unseen-agents";

/** What a platform's notifier is built over: the server's own state. */
export interface NotifierParts {
  notificationStore: NotificationStore;
  statsStore: StatsStore;
  unseen: UnseenAgents;
  preferencesManager: PreferencesManager;
  publish: BroadcastBus["publish"];
}

export interface Platform {
  /**
   * Where the server keeps its state: preferences, agents, projects, stats,
   * notifications and the rest.
   */
  dataDir: string;
  /**
   * The layout file `LayoutStore` persists to. The desktop's is
   * `~/.manor/layout.json` (`layoutFile()`), outside `dataDir`.
   */
  layoutFile: string;
  /** Seals the Linear token and the relay stores. */
  secretBox: SecretBox;
  /** The running app's version: the daemon handshake and the hello reply. */
  appVersion: string;
  /** This machine's name, for pairings and the hello reply. */
  hostName: () => string;
  /**
   * How the server's own daemon is reached. Absent: this machine's local
   * daemon socket, which may replace a daemon speaking another protocol.
   */
  daemonTransport?: HostTransport;
  /**
   * Where the server's keyless pushes go. Absent: a bus of its own, heard by
   * its bridge and nobody else in the process. The desktop passes the
   * process-wide sinks (`rendererBus`), which its menu and updater publish
   * into too.
   */
  bus?: BroadcastBus;
  /**
   * Builds the server's notifier. Absent: a `HeadlessNotifier`, with no dock
   * badge and no banners.
   */
  notifier?: (parts: NotifierParts) => ServerNotifier;
  /** Which renderer is the primary window, and the tab each detached one holds. */
  windows?: WindowDirectory;
  /**
   * The window whose being hidden pauses the diff watcher: the primary, read
   * on each start. Absent: nothing pauses it.
   */
  diffWindow?: () => DiffGateWindow | null;
  /**
   * The remote hosts this server reaches: registered from
   * `projects.json`, each with its hook cursor there. Absent on a host server,
   * which has no hosts of its own: every pane is local.
   */
  remoteHosts?: {
    /** Manor's own version, which remote hosts are matched against. */
    remoteVersion: string;
    /**
     * Where each host's offline cache goes. Defaults to
     * `~/.manor/host-cache/`.
     */
    hostCacheDir?: string;
  };
  /** Plays a notification sound by name (`preferences.playSound`). */
  playSound?: (soundName: string | false) => void;
  /** Settles a pending `appCommands.command` with the renderer's answer. */
  appCommandResult?: (result: AppCommandResult) => void;
}
