import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { HostIndicator } from "../../hosts/HostIndicator";

/**
 * Persistent per-project connection indicator (ADR-160 ticket 11 §2/§3).
 *
 * Mirrors `RemoteExposureIndicator`: nothing at all when the active
 * project's workspace lives on this machine, so it costs nothing in the
 * (still overwhelmingly common) local case. For a remote project it names
 * the host, adding the state while it isn't connected; clicking it opens
 * the project's Host settings, where Retry and the full error live.
 */
export function HostStatusIndicator() {
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const project = useProjectStore(
    useShallow((s) => {
      const p = s.projects.find((p) =>
        p.workspaces.some((w) => w.path === activeWorkspacePath),
      );
      return { id: p?.id, hostId: p?.hostId };
    }),
  );

  return <HostIndicator hostId={project.hostId} variant="chip" projectId={project.id} />;
}
