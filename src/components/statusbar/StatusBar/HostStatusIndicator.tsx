import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { projectForWorkspace, selectedProjectId } from "../../../lib/hosts";
import { HostIndicator } from "../../hosts/HostIndicator";

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
 * It follows the *workspace's* host, not the first project that lists the
 * path: in a linked group (ADR-192) the same path can be a workspace on
 * several hosts, and the chip names the one the user opened.
 */
export function HostStatusIndicator() {
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const project = useProjectStore(
    useShallow((s) => {
      const p = projectForWorkspace(s.projects, activeWorkspacePath, selectedProjectId(s));
      return { id: p?.id, hostId: p?.hostId };
    }),
  );

  return <HostIndicator hostId={project.hostId} variant="chip" projectId={project.id} />;
}
