/**
 * Branches and diffs watched on the host server that owns the workspace:
 * a caller's `branches.start` makes this server poll its own
 * checkout and publish `branches.changed` on its bus. See `harness.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import path from "node:path";

import { useHostServerHarness } from "./harness";

describe("host server: branches and diffs watched here", () => {
  const h = useHostServerHarness();

  it("publishes branches.changed for a git repo on this box", async () => {
    // The harness mocks `child_process` for the daemon's PTYs; the repo is real.
    const { execFileSync } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const repo = path.join(h.tmp, "repo");
    execFileSync("git", ["init", "-q", "-b", "feat", repo]);

    await h.serve();
    const owner = await h.owner();
    owner.subscribe("branches", "changed");
    await owner.invoke("branches", "start", [{ path: repo, hostId: "local" }]);

    const frame = await owner.waitFor(
      (f) => f.kind === "event" && f.ns === "branches" && f.event === "changed",
    );
    expect(frame).toMatchObject({ args: [{ [repo]: "feat" }] });

    // Its stop is the caller's own: the watch goes, and nothing else is refused.
    await owner.invoke("branches", "stop");
  });

  it("answers diffs.start and diffs.stop rather than refusing them", async () => {
    await h.serve();
    const owner = await h.owner();
    await owner.invoke("diffs", "start", [
      { path: path.join(h.tmp, "nowhere"), hostId: "local", defaultBranch: "main" },
    ]);
    await owner.invoke("diffs", "stop");
  });
});
