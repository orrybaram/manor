import { beforeEach, describe, expect, it, vi } from "vitest";

const del = vi.hoisted(() => vi.fn());

vi.mock("../../backend/providers/recipe-templates/signin", async (orig) => ({
  ...(await orig<typeof import("../../backend/providers/recipe-templates/signin")>()),
  deleteSignInSecret: del,
}));
vi.mock("../../renderer-broadcast", () => ({ publishRendererBroadcast: vi.fn() }));

import { hostProfilesRemove } from "../handlers/host-profiles";
import type { HostProfile } from "../../projects/types";

const signedIn: HostProfile = {
  id: "hp-1",
  name: "Work",
  templateId: "kubernetes",
  values: { context: "dev", namespace: "team" },
  signIn: { github: { setAt: 1, source: "gh" } },
};

function ctx(profile: HostProfile | undefined) {
  const removeHostProfile = vi.fn();
  return {
    removeHostProfile,
    ctx: {
      deps: { projectManager: { getHostProfile: () => profile, removeHostProfile } },
    } as unknown as Parameters<typeof hostProfilesRemove>[0],
  };
}

describe("hostProfiles.remove", () => {
  beforeEach(() => {
    del.mockReset().mockResolvedValue(undefined);
  });

  it("deletes the sign-in Secret, then removes the profile", async () => {
    const c = ctx(signedIn);
    await hostProfilesRemove(c.ctx, "hp-1");
    expect(del).toHaveBeenCalledWith(signedIn, expect.anything());
    expect(c.removeHostProfile).toHaveBeenCalledWith("hp-1");
  });

  it("keeps the profile when the delete fails", async () => {
    del.mockRejectedValue(new Error("kubectl could not delete the sign-in Secret: it failed"));
    const c = ctx(signedIn);
    await expect(hostProfilesRemove(c.ctx, "hp-1")).rejects.toThrow(/Couldn.t reach the cluster/);
    expect(c.removeHostProfile).not.toHaveBeenCalled();
  });

  it("makes no kubectl call without sign-in", async () => {
    const c = ctx({ ...signedIn, signIn: undefined });
    await hostProfilesRemove(c.ctx, "hp-1");
    const docker = ctx({ ...signedIn, templateId: "docker" });
    await hostProfilesRemove(docker.ctx, "hp-1");
    expect(del).not.toHaveBeenCalled();
    expect(c.removeHostProfile).toHaveBeenCalled();
    expect(docker.removeHostProfile).toHaveBeenCalled();
  });
});
