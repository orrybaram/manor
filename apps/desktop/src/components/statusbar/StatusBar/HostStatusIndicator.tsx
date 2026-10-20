import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { HostIndicator } from "../../hosts/HostIndicator";
import { HostGroupChips } from "./HostGroupChips";
import { activeWorkspaceHost } from "./active-workspace-host";

/**
 * Persistent connection indicator for the active workspace.
 *
 * Mirrors `RemoteExposureIndicator`: nothing at all when the active
 * workspace lives on this machine, so it costs nothing in the (still
 * overwhelmingly common) local case. For a remote workspace it names the
 * host, and only names it: the glyph and tone carry the state. Clicking it
 * opens the host popover, with the state in words, Retry, and a link to the
 * owning project's Host settings.
 *
 * It follows the active workspace's own host (`activeWorkspaceHostId`), so
 * in a linked group it names the host the user opened it on.
 *
 * Hosts made from a profile also get one chip per profile.
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

  return (
    <>
      <HostGroupChips skipHostId={hostId} />
      <HostIndicator hostId={hostId} variant="chip" projectId={projectId} />
    </>
  );
}
