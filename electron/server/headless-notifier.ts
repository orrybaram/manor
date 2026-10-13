/**
 * A server's notifications with no screen (ADR-227 D1): the agent broadcast,
 * the notification log's broadcast and its read marks. What a `ServerNotifier`
 * must do wherever it runs, and what the host server uses as it is.
 *
 * The desktop's `Notifier` (`../notifications.ts`) extends this with the dock
 * badge and native banners. Electron-free: the host server bundles it.
 */

import type { AgentInfo } from "../agent-persistence";
import type { UnseenAgents } from "../agent-status/unseen-agents";
import type { NotificationStore } from "../notification-store";
import type { ServerNotifier } from "../notifications";
import type { BroadcastBus } from "../renderer-broadcast";

export interface HeadlessNotifierOptions {
  /** ADR-162's durable notification log. */
  notificationStore: NotificationStore;
  unseen: UnseenAgents;
  /** Where broadcasts go: the server's bus. */
  publish: BroadcastBus["publish"];
}

export class HeadlessNotifier implements ServerNotifier {
  constructor(protected readonly opts: HeadlessNotifierOptions) {}

  sendNotificationsUpdate(): void {
    this.opts.publish(
      "notifications",
      "changed",
      this.opts.notificationStore.getAll(),
    );
  }

  markAgentNotificationsRead(agentId: string): void {
    if (!this.opts.notificationStore.markReadByAgent(agentId)) return;
    this.sendNotificationsUpdate();
  }

  sendAgentUpdate(agent: AgentInfo): void {
    this.opts.publish(
      "agents",
      "updated",
      agent,
      this.opts.unseen.flagsFor(agent.id),
    );
    this.updateDockBadge();
  }

  /** No dock here. */
  updateDockBadge(): void {}
}
