import { describe, expect, it, vi } from "vitest";
import { Duplex, PassThrough } from "node:stream";

// `host-pipe.ts` registers on `ipcMain` and imports the IPC transport's
// sender check; neither runs here, but both import electron at module scope.
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { HostPipes, viewerStreamable, type PipeOwner } from "../host-pipe";
import type { HostStatusInfo } from "../../backend/host-connection";

/** A viewer stream main's side can be handed: what the box says, and what it heard. */
function fakeStream() {
  const fromBox = new PassThrough();
  const written: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, callback) {
      written.push(chunk.toString("utf-8"));
      callback();
    },
  });
  fromBox.on("data", (chunk: Buffer) => stream.push(chunk));
  return { stream, say: (text: string) => fromBox.write(text), written };
}

function owner(id = 1) {
  const events: Array<[string, ...unknown[]]> = [];
  const o: PipeOwner = { id, emit: (channel, ...args) => events.push([channel, ...args]) };
  return { owner: o, events };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function pipes(opts: { canOpen?: boolean; open?: () => Promise<Duplex> } = {}) {
  const box = fakeStream();
  const openViewer = vi.fn(opts.open ?? (() => Promise.resolve(box.stream)));
  const hp = new HostPipes({
    canOpen: () => opts.canOpen ?? true,
    openViewer,
    log: () => {},
  });
  return { hp, box, openViewer };
}

describe("HostPipes (ADR-228 D4)", () => {
  it("answers with an id first, then carries the box's lines as they are", async () => {
    const { hp, box, openViewer } = pipes();
    const { owner: o, events } = owner();
    const pipeId = hp.open(o, "box");
    // Nothing is started before the window has its id.
    expect(openViewer).not.toHaveBeenCalled();
    await turn();
    expect(openViewer).toHaveBeenCalledWith("box");

    box.say('{"type":"hello","ok":true}\n{"kind":"ev');
    box.say('ent","x":1}\n\n');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toEqual([
      ["hostPipe:frame", pipeId, '{"type":"hello","ok":true}'],
      ["hostPipe:frame", pipeId, '{"kind":"event","x":1}'],
    ]);
  });

  it("writes the window's frames as lines, holding any sent before the stream was up", async () => {
    const { hp, box } = pipes();
    const { owner: o } = owner();
    const pipeId = hp.open(o, "box");
    hp.send(1, pipeId, '{"a":1}');
    await turn();
    await turn();
    hp.send(1, pipeId, '{"b":2}');
    // A newline would make one frame two; another window's send is not its own.
    hp.send(1, pipeId, '{"c":\n3}');
    hp.send(2, pipeId, '{"d":4}');
    expect(box.written.join("")).toBe('{"a":1}\n{"b":2}\n');
  });

  it("refuses a host it may not open with 4504, after the id", async () => {
    const { hp, openViewer } = pipes({ canOpen: false });
    const { owner: o, events } = owner();
    const pipeId = hp.open(o, "box");
    expect(events).toEqual([]);
    await turn();
    expect(events).toEqual([["hostPipe:closed", pipeId, 4504]]);
    expect(openViewer).not.toHaveBeenCalled();
    expect(hp.hosts().size).toBe(0);
  });

  it("closes with 4504 when the stream cannot be opened, or ends", async () => {
    const failing = pipes({ open: () => Promise.reject(new Error("exit 3")) });
    const a = owner();
    const failed = failing.hp.open(a.owner, "box");
    await vi.waitFor(() => expect(a.events).toEqual([["hostPipe:closed", failed, 4504]]));

    const { hp, box } = pipes();
    const b = owner();
    const ended = hp.open(b.owner, "box");
    await turn();
    await turn();
    box.stream.destroy();
    await vi.waitFor(() => expect(b.events).toEqual([["hostPipe:closed", ended, 4504]]));
  });

  it("ends every pipe to a lost host with 4504, and a closed window's without a word", async () => {
    const streams: ReturnType<typeof fakeStream>[] = [];
    const hp = new HostPipes({
      canOpen: () => true,
      openViewer: () => {
        const s = fakeStream();
        streams.push(s);
        return Promise.resolve(s.stream);
      },
      log: () => {},
    });
    const one = owner(1);
    const two = owner(2);
    const lost = hp.open(one.owner, "box");
    const kept = hp.open(one.owner, "other");
    hp.open(two.owner, "other");
    await turn();
    await turn();
    expect(streams).toHaveLength(3);

    hp.hostGone("box");
    expect(one.events).toEqual([["hostPipe:closed", lost, 4504]]);
    expect(streams[0].stream.destroyed).toBe(true);

    hp.dropOwner(2);
    expect(two.events).toEqual([]);
    expect(streams[2].stream.destroyed).toBe(true);
    expect(streams[1].stream.destroyed).toBe(false);

    // The window closes its own: not told, and its stream goes.
    hp.close(2, kept); // not window 2's
    expect(streams[1].stream.destroyed).toBe(false);
    hp.close(1, kept);
    expect(streams[1].stream.destroyed).toBe(true);
    await turn();
    expect(one.events).toEqual([["hostPipe:closed", lost, 4504]]);
    expect(hp.hosts().size).toBe(0);
  });

  it("drops a stream that opens after the window gave up on it", async () => {
    let resolve!: (stream: Duplex) => void;
    const { hp } = pipes({ open: () => new Promise((r) => (resolve = r)) });
    const { owner: o, events } = owner();
    const pipeId = hp.open(o, "box");
    await turn();
    hp.close(1, pipeId);
    const late = fakeStream();
    resolve(late.stream);
    await turn();
    expect(late.stream.destroyed).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("viewerStreamable", () => {
  const host = (over: Partial<HostStatusInfo>): HostStatusInfo => ({
    hostId: "box",
    spec: null,
    status: "connected",
    viewerBridge: true,
    ...over,
  });

  it("needs the host connected, adopted, and its server reporting viewer-bridge", () => {
    expect(viewerStreamable(host({}), true)).toBe(true);
    expect(viewerStreamable(host({}), false)).toBe(false);
    expect(viewerStreamable(host({ viewerBridge: false }), true)).toBe(false);
    expect(viewerStreamable(host({ viewerBridge: undefined }), true)).toBe(false);
    expect(viewerStreamable(host({ status: "reconnecting" }), true)).toBe(false);
    expect(viewerStreamable(undefined, true)).toBe(false);
  });
});
