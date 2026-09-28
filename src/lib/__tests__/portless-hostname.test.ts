import { describe, it, expect } from "vitest";
import {
  hostSegments,
  portlessHostFor,
  portlessHostname,
} from "../portless-hostname";
import { ghRepoOf } from "../gh-repo";

describe("hostSegments", () => {
  it("keeps the first 8 characters of a host id, lowercased", () => {
    expect(hostSegments(["3F1C2A9E-aaaa", "b0x"])).toEqual(
      new Map([
        ["3F1C2A9E-aaaa", "3f1c2a9e"],
        ["b0x", "b0x"],
      ]),
    );
  });

  it("falls back to the full sanitized id only for hosts sharing a prefix", () => {
    expect(hostSegments(["abcdefgh-1", "ABCDEFGH-2", "12345678-3"])).toEqual(
      new Map([
        ["abcdefgh-1", "abcdefgh-1"],
        ["ABCDEFGH-2", "abcdefgh-2"],
        ["12345678-3", "12345678"],
      ]),
    );
  });
});

describe("portlessHostFor", () => {
  const segments = hostSegments(["3f1c2a9e-1"]);

  it("names this machine, a registered host and an unregistered one", () => {
    expect(portlessHostFor("local", segments)).toEqual({ kind: "local" });
    expect(portlessHostFor("3f1c2a9e-1", segments)).toEqual({
      kind: "remote",
      segment: "3f1c2a9e",
    });
    expect(portlessHostFor("gone", segments)).toEqual({ kind: "unknown" });
  });
});

describe("portlessHostname", () => {
  const main = { path: "/code/Acme App", projectName: null, branch: "main", isMain: true };
  const branch = { ...main, projectName: "Acme", branch: "Feat/X", isMain: false };
  const remote = { kind: "remote", segment: "3f1c2a9e" } as const;

  it("leaves local hostnames as they were", () => {
    expect(portlessHostname(main, { kind: "local" })).toBe("acme-app.localhost");
    expect(portlessHostname(branch, { kind: "local" })).toBe("feat-x.acme.localhost");
  });

  it("puts a remote host's segment before .localhost", () => {
    expect(portlessHostname(main, remote)).toBe("acme-app.3f1c2a9e.localhost");
    expect(portlessHostname(branch, remote)).toBe("feat-x.acme.3f1c2a9e.localhost");
  });
});

describe("ghRepoOf", () => {
  it("names a project's root on its host, a missing host being local", () => {
    expect(ghRepoOf({ path: "/a", hostId: "box" })).toEqual({ path: "/a", hostId: "box" });
    expect(ghRepoOf({ path: "/a" })).toEqual({ path: "/a", hostId: "local" });
  });
});
