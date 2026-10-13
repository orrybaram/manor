/**
 * The owner channel (ADR-218 D4): what the desktop pushes to a host server
 * (manifest, layout), how it is validated, persisted and served to a phone.
 * See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";

import { useHostServerHarness, withoutGit } from "./harness";
import { hostLayoutSnapshot } from "../../backend/host-server-sync";
import { ownerTokenAuthenticator } from "../socket";
import type { HostManifest } from "../manifest";
import type { HostLayoutSnapshot } from "../layout";
import type { ProjectInfo } from "../../projects/types";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { PairResult } from "../../remote-control/relay-room";

describe("the owner channel (ADR-218 D4)", () => {
  const h = useHostServerHarness();

  function manifest(projectPath: string): HostManifest {
    return {
      version: 1,
      sentAt: "2026-10-12T10:00:00.000Z",
      projects: [
        {
          id: "proj-1",
          name: "Manor",
          path: projectPath,
          hostId: "local",
          selectedWorkspaceIndex: 0,
          workspaces: [],
          defaultBranch: "main",
          defaultRunCommand: null,
          worktreePath: null,
          color: "#f00",
          workspaceNames: { [projectPath]: "Main checkout" },
          workspaceIssues: {
            [projectPath]: [
              {
                id: "i-1",
                identifier: "ENG-1",
                title: "Fix it",
                url: "https://linear.app/i-1",
              },
            ],
          },
        },
      ],
      integrationSnapshot: {
        [projectPath]: {
          takenAt: "2026-10-12T09:59:00.000Z",
          issue: { id: "i-1", title: "Fix it", url: "https://linear.app/i-1" },
          pr: {
            number: 7,
            state: "open",
            title: "Fix it",
            url: "https://github.com/o/r/pull/7",
          },
        },
      },
    };
  }

  function entry(version: number, paneId: string): LayoutEntry {
    return {
      version,
      layout: {
        panelTree: { type: "leaf", panelId: "p" },
        panels: {},
      } as never,
      defaultViewport: {} as never,
      paneSessions: { [paneId]: { sessionId: paneId } as never },
      claims: [{ windowId: "w", tabId: "t" } as never],
    };
  }

  it("authenticates the owner token, and only it, as the owner", () => {
    const auth = ownerTokenAuthenticator("tok");
    expect(auth("tok")).toEqual({
      ok: true,
      caller: { callerClass: "owner", deviceId: null, deviceLabel: null },
    });
    expect(auth("nope")).toMatchObject({ ok: false, code: 4401 });
    expect(auth(undefined)).toMatchObject({ ok: false, code: 4401 });
  });

  it("names itself in the hello, and the desktop's name wins", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const first = await h.phone(paired.pairingUrl);
    expect(first.hello.hostName).toBe(os.hostname());

    await client.invoke("hostServer", "syncManifest", {
      ...manifest(h.tmp),
      hostName: "me@devbox",
    });
    const second = await h.phone(paired.pairingUrl);
    expect(second.hello.hostName).toBe("me@devbox");
  });

  it("persists a synced manifest, serves it, and tells a subscribed phone", async () => {
    // There is no git in this test: every worktree listing fails at once,
    // so a project shows its main checkout, as on a box without the repo.
    withoutGit();
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    p.viewer.send({ kind: "subscribe", ns: "projects", event: "changed" });
    // The subscribe has no reply; a round trip makes sure it landed.
    await p.call("agents", "getAll");

    expect(
      await client.invoke("hostServer", "syncManifest", manifest(h.tmp)),
    ).toBe(true);

    const onDisk = JSON.parse(
      fs.readFileSync(h.paths.manifest, "utf-8"),
    ) as HostManifest;
    expect(onDisk).toEqual(manifest(h.tmp));
    expect(fs.statSync(h.paths.manifest).mode & 0o777).toBe(0o600);
    // No temp file left behind by the atomic write.
    expect(
      fs.readdirSync(h.paths.dataDir).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);

    await p.viewer.next(
      (f) => f.kind === "event" && f.ns === "projects" && f.event === "changed",
    );

    const projects = await p.call("projects", "getAll");
    expect(projects).toMatchObject({ ok: true });
    const list = projects.result as ProjectInfo[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "proj-1",
      name: "Manor",
      hostId: "local",
      color: "#f00",
    });
    expect(list[0].workspaces[0]).toMatchObject({
      path: h.tmp,
      name: "Main checkout",
      linkedIssues: [expect.objectContaining({ identifier: "ENG-1" })],
    });
  });

  it("rewrites only this host's layout keys to bare paths, and serves the snapshot", async () => {
    const snapshot = hostLayoutSnapshot(
      {
        "box:/home/me/a": entry(3, "pane-a"),
        "box:/home/me/b": entry(1, "pane-b"),
        "other:/home/me/a": entry(9, "pane-x"),
        "/Users/me/local": entry(2, "pane-l"),
      },
      "box:/home/me/b",
      "box",
      "2026-10-12T10:00:00.000Z",
    );
    expect(Object.keys(snapshot.workspaces).sort()).toEqual([
      "/home/me/a",
      "/home/me/b",
    ]);
    expect(snapshot.workspaces["/home/me/a"].version).toBe(3);
    expect(snapshot.workspaces["/home/me/a"].claims).toEqual([]);
    expect(snapshot.lastActiveWorkspacePath).toBe("/home/me/b");
    // Last active on another host is not this host's to show.
    expect(
      hostLayoutSnapshot({}, "other:/home/me/a", "box", "t")
        .lastActiveWorkspacePath,
    ).toBeNull();

    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    p.viewer.send({ kind: "subscribe", ns: "layout", event: "changed" });
    await p.call("agents", "getAll");

    expect(await client.invoke("hostServer", "syncLayout", snapshot)).toBe(
      true,
    );
    expect(
      (
        JSON.parse(
          fs.readFileSync(h.paths.layout, "utf-8"),
        ) as HostLayoutSnapshot
      ).workspaces,
    ).toEqual(snapshot.workspaces);
    expect(await p.call("layout", "getAll")).toMatchObject({
      ok: true,
      result: snapshot.workspaces,
    });
    expect(await p.call("layout", "getLastActive")).toMatchObject({
      ok: true,
      result: "/home/me/b",
    });
    const changed = await p.viewer.next(
      (f) =>
        f.kind === "event" &&
        f.ns === "layout" &&
        (f.args as Array<{ workspacePath: string }>)[0].workspacePath ===
          "/home/me/a",
    );
    expect((changed.args as LayoutEntry[])[0]).toMatchObject({
      version: 3,
      claims: [],
    });

    // A workspace dropped from the next snapshot is announced removed.
    const { ["/home/me/b"]: _dropped, ...rest } = snapshot.workspaces;
    await client.invoke("hostServer", "syncLayout", {
      ...snapshot,
      workspaces: rest,
      lastActiveWorkspacePath: null,
    });
    await p.viewer.next(
      (f) =>
        f.kind === "event" &&
        f.ns === "layout" &&
        (f.args as Array<{ workspacePath: string; removed?: boolean }>)[0]
          .workspacePath === "/home/me/b" &&
        (f.args as Array<{ removed?: boolean }>)[0].removed === true,
    );
  });

  it("refuses a malformed manifest or layout and keeps what it had", async () => {
    // `layout.getAll` lists worktrees to place the live session; no git here.
    withoutGit();
    await h.serve();
    const client = await h.owner();
    await client.invoke("hostServer", "syncManifest", manifest(h.tmp));
    const before = fs.readFileSync(h.paths.manifest, "utf-8");

    const bad: unknown[] = [
      null,
      { ...manifest(h.tmp), version: 2 },
      // Not rewritten to local.
      {
        ...manifest(h.tmp),
        projects: [{ ...manifest(h.tmp).projects[0], hostId: "box" }],
      },
      {
        ...manifest(h.tmp),
        projects: [{ ...manifest(h.tmp).projects[0], path: "relative" }],
      },
      {
        ...manifest(h.tmp),
        integrationSnapshot: { [h.tmp]: { takenAt: 1, issue: null, pr: null } },
      },
      {
        ...manifest(h.tmp),
        projects: [
          { ...manifest(h.tmp).projects[0], workspaceNames: { a: 1 } },
        ],
      },
    ];
    for (const payload of bad) {
      await expect(
        client.invoke("hostServer", "syncManifest", payload),
      ).rejects.toThrow();
    }
    expect(fs.readFileSync(h.paths.manifest, "utf-8")).toBe(before);

    const good = hostLayoutSnapshot(
      { "box:/a": entry(1, "p") },
      null,
      "box",
      "t",
    );
    for (const payload of [
      { ...good, version: 9 },
      // A host-qualified key was not rewritten.
      { ...good, workspaces: { "box:/a": good.workspaces["/a"] } },
      { ...good, workspaces: { "/a": { version: 1 } } },
      { ...good, lastActiveWorkspacePath: "box:/a" },
    ]) {
      await expect(
        client.invoke("hostServer", "syncLayout", payload),
      ).rejects.toThrow();
    }
    expect(fs.existsSync(h.paths.layout)).toBe(false);
    // No snapshot was kept: all a phone sees is the live session, in a
    // synthetic tab (ADR-218 D5).
    const served = await client.invoke<Record<string, LayoutEntry>>(
      "layout",
      "getAll",
    );
    expect(Object.keys(served)).toEqual([h.tmp]);
    expect(Object.values(served[h.tmp].layout.panels)[0].tabs).toMatchObject([
      { title: "Started while away" },
    ]);
  });
});
