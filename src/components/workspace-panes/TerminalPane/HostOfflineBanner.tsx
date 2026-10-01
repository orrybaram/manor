import { paneRemoteHost, useRemotePaneStore } from "../../../store/remote-pane-store";
import { HostIndicator } from "../../hosts/HostIndicator";
import { useWorkspaceProjectId } from "../../../hooks/useWorkspaceProjectId";
import type { WorkspaceKey } from "../../../lib/workspace-key";

type HostOfflineBannerProps = {
  paneId: string;
  /** The pane's workspace, so the overlay can open its project's Host settings. */
  workspaceKey?: WorkspaceKey;
};

/**
 * Covers a terminal whose remote host is away (ADR-178 §6). The terminal
 * underneath keeps its last screen and ignores input until the host is back
 * (`isHostOffline`). Renders nothing for a local pane.
 */
export function HostOfflineBanner(props: HostOfflineBannerProps) {
  const { paneId, workspaceKey } = props;
  const hostId = useRemotePaneStore((s) => paneRemoteHost(s, paneId));
  // Looked up only for a remote pane, so local panes stay off the project store.
  const projectId = useWorkspaceProjectId(hostId ? workspaceKey : null);
  return <HostIndicator hostId={hostId} variant="banner" projectId={projectId} />;
}
