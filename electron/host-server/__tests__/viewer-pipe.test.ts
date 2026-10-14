/**
 * A desktop window's own stream to a host server (ADR-228 D4), end to end
 * but for ssh: the renderer's transport (`createHostPipeTransport`) over a
 * `hostPipe` wired straight to main's `HostPipes`, whose viewer stream is a
 * real `server-bridge --viewer` run in process against the harness's
 * server. See `harness.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { Duplex, PassThrough } from "node:stream";

import { eventually, useHostServerHarness, withoutGit } from "./harness";

// `host-pipe.ts` registers on `ipcMain`; nothing here does.
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { HostPipes, type PipeOwner } from "../../ipc/host-pipe";
import { runServerBridge } from "../../terminal-host/server-bridge";
import {
  createHostPipeTransport,
  type HostPipeApi,
} from "../../../src/bridge/transports/host-pipe";
import type { HelloReply } from "../../../src/bridge/transports/ws";
import type { ProjectInfo } from "../../projects/types";

describe("a desktop window's viewer pipe (ADR-228 D4)", () => {
  const h = useHostServerHarness();

  /**
   * `manor-host server-bridge --viewer` on stdio the test holds, as the ssh
   * child's would be: what the window writes is its stdin, what the server
   * says (its hello reply first) is its stdout.
   */
  function viewerStream(): Promise<Duplex> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stream = new Duplex({
      read: () => stdout.resume(),
      write: (chunk: Buffer, _encoding, callback) => stdin.write(chunk, callback),
      final: (callback) => stdin.end(callback),
    });
    stdout.on("data", (chunk: Buffer) => {
      if (!stream.push(chunk)) stdout.pause();
    });
    void runServerBridge(
      { stdin, stdout, stderr: new PassThrough() },
      {
        paths: h.paths,
        ensureServerRunning: async () => {},
        viewer: true,
      },
    ).finally(() => stream.destroy());
    return Promise.resolve(stream);
  }

  /** `window.manorHost.native.hostPipe`, straight onto main's side. */
  function hostPipeApi(pipes: HostPipes): HostPipeApi {
    const frames = new Set<(pipeId: string, text: string) => void>();
    const closes = new Set<(pipeId: string, code: number) => void>();
    const window: PipeOwner = {
      id: 1,
      emit: (channel, pipeId, payload) => {
        if (channel === "hostPipe:frame") {
          for (const cb of [...frames]) cb(pipeId as string, payload as string);
        } else if (channel === "hostPipe:closed") {
          for (const cb of [...closes]) cb(pipeId as string, payload as number);
        }
      },
    };
    return {
      open: (hostId) => Promise.resolve(pipes.open(window, hostId)),
      send: (pipeId, text) => pipes.send(window.id, pipeId, text),
      close: (pipeId) => pipes.close(window.id, pipeId),
      onFrame: (cb) => {
        frames.add(cb);
        return () => frames.delete(cb);
      },
      onClosed: (cb) => {
        closes.add(cb);
        return () => closes.delete(cb);
      },
    };
  }

  it("calls projects.getAll on the host server and hears its projects.changed", async () => {
    withoutGit();
    await h.serve();
    const pipes = new HostPipes({
      canOpen: () => true,
      openViewer: viewerStream,
      log: () => {},
    });
    const hellos: HelloReply[] = [];
    const transport = createHostPipeTransport(hostPipeApi(pipes), "box", {
      onHello: (reply) => hellos.push(reply),
    });
    const changed: unknown[][] = [];
    transport.subscribe("projects", "changed", undefined, (...args) => changed.push(args));

    expect(await transport.invoke("projects", "getAll", [])).toEqual([]);
    // The hello `server-bridge` said, answered by the host server.
    expect(hellos).toEqual([
      expect.objectContaining({ hostServer: true, resumed: false }),
    ]);
    expect(hellos[0].rendererId).toEqual(expect.any(String));

    // Main's owner channel hands the host its projects (ADR-227 D3); the
    // window hears it on its own stream.
    const owner = await h.owner();
    await owner.invoke("hostServer", "adopt", {
      projects: [
        {
          id: "p1",
          name: "demo",
          path: h.tmp,
          hostId: "local",
          defaultBranch: "main",
          selectedWorkspaceIndex: 0,
          workspaces: [],
        },
      ],
      agents: [],
      layout: { version: 1, takenAt: "now", workspaces: {}, lastActiveWorkspacePath: null },
    });
    await eventually(() => changed.length, (n) => n > 0, "projects.changed on the viewer pipe");

    const all = (await transport.invoke("projects", "getAll", [])) as ProjectInfo[];
    expect(all.map((p) => p.id)).toEqual(["p1"]);
    expect(all[0]).toMatchObject({ name: "demo", hostId: "local" });

    pipes.dispose();
  });
});
