import { useHostStore, type HostStatusInfo } from "../store/host-store";
import { useToastStore } from "../store/toast-store";
import { hostName } from "./hosts";
import { requestUi } from "../utils/ui-request";

/** A host made for one project that removing the project could delete too. */
export interface ProjectPod {
  hostId: string;
  name: string;
  /** Whether the host is a docker container rather than a pod. */
  docker: boolean;
  canStop: boolean;
}

/**
 * The hosts a removal of `members` could take with it: each
 * member's host, when it was made for that member and Manor can destroy it.
 */
export function podsOf(
  members: ReadonlyArray<{ id: string; hostId: string }>,
  hosts: readonly HostStatusInfo[],
): ProjectPod[] {
  const pods: ProjectPod[] = [];
  for (const member of members) {
    const host = hosts.find((h) => h.hostId === member.hostId);
    if (!host || host.forProject !== member.id || !host.capabilities?.canDestroy) continue;
    if (pods.some((p) => p.hostId === host.hostId)) continue;
    pods.push({
      hostId: host.hostId,
      name: hostName(host),
      docker: host.template === "docker",
      canStop: host.capabilities.canStop,
    });
  }
  return pods;
}

/** "Also delete its pod and disk" (a docker host: "container and volume"). */
export function deletePodsLabel(pods: readonly ProjectPod[]): string {
  const docker = pods.every((p) => p.docker);
  if (pods.length === 1) {
    return docker ? "Also delete its container and volume" : "Also delete its pod and disk";
  }
  return docker ? "Also delete their containers and volumes" : "Also delete their pods and disks";
}

/**
 * After the projects are removed: delete each pod and its disk, or leave it
 * stopped. A failed delete leaves the host in `error` and says
 * so; the projects stay removed either way.
 */
export async function finishPods(pods: readonly ProjectPod[], destroy: boolean): Promise<void> {
  const { removeHost, stop } = useHostStore.getState();
  for (const pod of pods) {
    if (destroy) {
      try {
        await removeHost(pod.hostId, true);
      } catch {
        useToastStore.getState().addToast({
          id: `delete-pod-${pod.hostId}`,
          message: `Couldn't delete ${pod.name}'s pod`,
          status: "error",
          action: {
            label: "Open Hosts settings",
            onClick: () => requestUi({ type: "open-hosts-settings", hostId: pod.hostId }),
          },
        });
      }
    } else if (pod.canStop) {
      // Its `forProject` went with the project; the pod keeps running as an
      // ordinary host unless stopped.
      try {
        await stop(pod.hostId);
      } catch {
        // Left running; the host's row in Settings shows its state.
      }
    }
  }
}
