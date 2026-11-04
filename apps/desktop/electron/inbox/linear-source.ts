import { INBOX_TYPES, type InboxKind } from "../../src/lib/inbox";
import type { InboxItem, InboxSource } from "./inbox-poller";

/** One node of Linear's `notifications`. Only issue notifications have `issue`. */
export interface LinearNotificationNode {
  id: string;
  category: string;
  readAt: string | null;
  snoozedUntilAt: string | null;
  team?: { id: string } | null;
  issue?: { identifier: string; title: string; url: string } | null;
}

export interface LinearSourceDeps {
  isConnected(): boolean;
  fetchNotifications(since: string | undefined): Promise<LinearNotificationNode[]>;
  /** The ids of the teams linked to projects. */
  projectTeams(): Promise<Set<string>>;
  now?: () => number;
}

/**
 * Linear discourages polling and offers webhooks, which can't reach a desktop.
 * Two minutes is about 30 of the 2,500 requests an hour it allows a user.
 */
export const LINEAR_INTERVAL_MS = 2 * 60_000;

const KIND_BY_CATEGORY = new Map<string, InboxKind>(
  INBOX_TYPES.filter((t) => t.source === "linear").map((t) => [t.upstream, t.kind]),
);

const TITLE_PREFIX: Partial<Record<InboxKind, string>> = {
  "linear-assigned": "Assigned",
  "linear-mentioned": "Mentioned",
  "linear-comment": "Comment",
  "linear-status-changed": "Status changed",
  "linear-triage": "Triage",
  "linear-review": "Review",
  "linear-reaction": "Reaction",
};

/** Null for a node with no issue, and for one read or still snoozed. */
export function nodeToItem(
  node: LinearNotificationNode,
  teams: ReadonlySet<string>,
  nowMs: number,
): InboxItem | null {
  if (node.readAt) return null;
  if (node.snoozedUntilAt && Date.parse(node.snoozedUntilAt) > nowMs) return null;
  if (!node.issue) return null;
  const kind = KIND_BY_CATEGORY.get(node.category) ?? null;
  const prefix = kind ? TITLE_PREFIX[kind] : undefined;
  return {
    key: node.id,
    kind,
    inScope: !!node.team && teams.has(node.team.id),
    title: prefix ? `${prefix}: ${node.issue.identifier}` : node.issue.identifier,
    body: `Linear · ${node.issue.title}`,
    url: node.issue.url.startsWith("https://linear.app/") ? node.issue.url : null,
  };
}

export function createLinearSource(deps: LinearSourceDeps): InboxSource {
  return {
    id: "linear",
    intervalMs: LINEAR_INTERVAL_MS,
    isReady: async () => deps.isConnected(),
    coverage: async () => (await deps.projectTeams()).size,
    async fetch(since) {
      const [nodes, teams] = await Promise.all([
        deps.fetchNotifications(since),
        deps.projectTeams(),
      ]);
      const now = (deps.now ?? Date.now)();
      // One malformed node mustn't stop the rest, now or on every retry.
      const items = nodes.flatMap((node) => {
        try {
          return nodeToItem(node, teams, now) ?? [];
        } catch {
          return [];
        }
      });
      return { status: "ok", items };
    },
  };
}
