import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { HostIndicator } from "../../hosts/HostIndicator";
import { activeWorkspaceHost } from "./active-workspace-host";

/**
 * Persistent connection indicator for the active workspace (ADR-160 ticket
 * 11 §2/§3).
 *
 * Mirrors `RemoteExposureIndicator`: nothing at all when the active
 * workspace lives on this machine, so it costs nothing in the (still
 * overwhelmingly common) local case. For a remote workspace it names the
 * host, adding the state while it isn't connected; clicking it opens the
 * owning project's Host settings, where Retry and the full error live.
 *
 * It follows the active workspace's own host (`activeWorkspaceHostId`), so
 * in a linked group (ADR-192) it names the host the user opened it on.
 */
export function HostStatusIndicator() {
  const app = useAppStore(
    useShallow((s) => ({
      activeWorkspacePath: s.activeWorkspacePath,
      activeWorkspaceHostId: s.activeWorkspaceHostId,
    })),
  );
  const projects = useProjectStore((s) => s.projects);
  const { hostId, projectId } = activeWorkspaceHost(app, projects);

  return <HostIndicator hostId={hostId} variant="chip" projectId={projectId} />;
}
