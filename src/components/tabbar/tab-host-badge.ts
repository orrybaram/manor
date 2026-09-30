import { normalizeHostId } from "../../lib/workspace-key";

/**
 * The host a tab's "different host" badge names, or null for no badge.
 * `tabHostId` is the remote host the tab's panes run on (null for panes on
 * this machine); `workspaceHostId` is the host of the workspace the tab
 * belongs to — not its project's, which in a linked group (ADR-192) is only
 * one of several. The badge shows only when the two differ.
 */
export function tabBadgeHostId(
  tabHostId: string | null | undefined,
  workspaceHostId: string | null | undefined,
): string | null {
  if (!tabHostId) return null;
  return tabHostId === normalizeHostId(workspaceHostId) ? null : tabHostId;
}
