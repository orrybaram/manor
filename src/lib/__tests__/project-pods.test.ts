import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletePodsLabel, finishPods, podsOf } from "../project-pods";
import { useHostStore, type HostStatusInfo } from "../../store/host-store";
import { useToastStore } from "../../store/toast-store";

const electronAPI = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
const originalHosts = electronAPI.hosts;

function pod(over: Partial<HostStatusInfo> = {}): HostStatusInfo {
  return {
    hostId: "h1",
    spec: { kind: "recipe", recipeId: "r" },
    label: "app-pod",
    status: "connected",
    forProject: "p1",
    template: "kubernetes",
    capabilities: { canStop: true, canDestroy: true, autoSleep: false },
    ...over,
  };
}

describe("podsOf", () => {
  it("offers a host made for the member that Manor can destroy", () => {
    expect(podsOf([{ id: "p1", hostId: "h1" }], [pod()])).toEqual([
      { hostId: "h1", name: "app-pod", docker: false, canStop: true },
    ]);
  });

  it("skips hosts made for another project, or that cannot be destroyed", () => {
    expect(podsOf([{ id: "p2", hostId: "h1" }], [pod()])).toEqual([]);
    const ssh = pod({ capabilities: { canStop: false, canDestroy: false, autoSleep: false } });
    expect(podsOf([{ id: "p1", hostId: "h1" }], [ssh])).toEqual([]);
  });

  it("finds each pod member of a group", () => {
    const hosts = [pod(), pod({ hostId: "h2", forProject: "p2", template: "docker" })];
    const pods = podsOf(
      [
        { id: "p1", hostId: "h1" },
        { id: "p2", hostId: "h2" },
        { id: "p3", hostId: "local" },
      ],
      hosts,
    );
    expect(pods.map((p) => p.hostId)).toEqual(["h1", "h2"]);
  });

  it("words the label for pods and for docker", () => {
    expect(deletePodsLabel(podsOf([{ id: "p1", hostId: "h1" }], [pod()]))).toBe(
      "Also delete its pod and disk",
    );
    const docker = podsOf([{ id: "p1", hostId: "h1" }], [pod({ template: "docker" })]);
    expect(deletePodsLabel(docker)).toBe("Also delete its container and volume");
  });
});

describe("finishPods", () => {
  const remove = vi.fn();
  const stop = vi.fn();
  const pods = [{ hostId: "h1", name: "app-pod", docker: false, canStop: true }];

  beforeEach(() => {
    remove.mockReset().mockResolvedValue(undefined);
    stop.mockReset().mockResolvedValue(undefined);
    electronAPI.hosts = { remove, stop, onStatusChanged: vi.fn(() => vi.fn()) };
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    electronAPI.hosts = originalHosts;
  });

  it("checked: destroys the host with its disk", async () => {
    await finishPods(pods, true);
    expect(remove).toHaveBeenCalledWith("h1", { destroy: true });
    expect(stop).not.toHaveBeenCalled();
  });

  it("checked, destroy fails: toasts with a way to Hosts settings", async () => {
    remove.mockRejectedValue(new Error("nope"));
    await finishPods(pods, true);
    const toast = useToastStore.getState().toasts[0];
    expect(toast?.message).toBe("Couldn't delete app-pod's pod");
    expect(toast?.action?.label).toBe("Open Hosts settings");
  });

  it("unchecked: stops the host and deletes nothing", async () => {
    await finishPods(pods, false);
    expect(stop).toHaveBeenCalledWith("h1");
    expect(remove).not.toHaveBeenCalled();
  });

  it("unchecked: a host that cannot stop is left alone", async () => {
    await finishPods([{ ...pods[0]!, canStop: false }], false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the store usable", () => {
    expect(useHostStore.getState().removeHost).toBeTypeOf("function");
  });
});
