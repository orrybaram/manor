import { describe, expect, it } from "vitest";
import { groupHostsByProfile, runningSummary } from "./host-groups";

const h = (hostId: string, status: string, profileId?: string) => ({ hostId, status, profileId });

describe("groupHostsByProfile", () => {
  const profiles = [{ id: "a" }, { id: "b" }, { id: "empty" }];

  it("groups by profile in profile order and counts running", () => {
    const r = groupHostsByProfile(
      [h("1", "connected", "b"), h("2", "sleeping", "a"), h("3", "connected", "a")],
      profiles,
    );
    expect(r.groups.map((g) => g.profile.id)).toEqual(["a", "b"]);
    expect(r.groups[0]).toMatchObject({ running: 1, total: 2 });
    expect(runningSummary(r.groups[0])).toBe("1 of 2 running");
    expect(r.rest).toEqual([]);
  });

  it("keeps unprofiled and unknown-profile hosts in the flat list", () => {
    const r = groupHostsByProfile([h("1", "connected"), h("2", "connected", "gone")], profiles);
    expect(r.groups).toEqual([]);
    expect(r.rest.map((x) => x.hostId)).toEqual(["1", "2"]);
  });

  it("lists errored grouped hosts separately too", () => {
    const r = groupHostsByProfile([h("1", "error", "a"), h("2", "connected", "a")], profiles);
    expect(r.errored.map((x) => x.hostId)).toEqual(["1"]);
    expect(r.groups[0]).toMatchObject({ running: 1, total: 2 });
  });
});
