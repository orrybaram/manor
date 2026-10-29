import { describe, expect, it, vi } from "vitest";

import type { HostProxy } from "../../../backend/host-proxy";
import { HostServerUnavailableError } from "../../../backend/host-server-client";
import { PendingCommands } from "../../../layout/pending-commands";
import { PtyAttachments } from "../../../pty-attachments";
import { createBroadcastBus } from "../../../renderer-broadcast";
import { HostRouting } from "../../../server/host-routing";
import type { SessionSummary } from "../../../sessions/types";
import { HOST_TABLE } from "../../../host-server/handlers";
import type { HandlerCtx } from "../../method";
import { sessionsList, type SessionsDeps } from "../sessions";

function session(sessionId: string, updatedAt: string, hostId = "local"): SessionSummary {
  return {
    hostId,
    kind: "claude",
    sessionId,
    title: sessionId,
    firstPrompt: sessionId,
    cwd: "/w",
    gitBranch: null,
    createdAt: updatedAt,
    updatedAt,
    messageCount: null,
    model: null,
    path: `/w/${sessionId}.jsonl`,
    parentSessionId: null,
  };
}

/** A proxy whose host server answers `sessions.list` with `answer`. */
function proxy(hostId: string, answer: () => Promise<unknown>): HostProxy {
  return {
    hostId,
    label: hostId,
    invoke: vi.fn(async (ns: string, method: string) => {
      if (ns !== "sessions" || method !== "list") throw new Error(`unexpected ${ns}.${method}`);
      return answer();
    }),
  } as unknown as HostProxy;
}

function routing(proxies: HostProxy[]): HostRouting {
  return new HostRouting({
    registry: {
      hostProxy: (hostId) => proxies.find((p) => p.hostId === hostId),
      remoteHostIds: () => proxies.map((p) => p.hostId),
      sessions: { ownerOf: () => undefined },
    },
    isAdopted: () => true,
    hasLocalProject: () => false,
    pendingCommands: new PendingCommands(),
    decorateProject: (result) => result,
    bus: createBroadcastBus(),
    handOver: async () => {},
    attachments: new PtyAttachments(),
  });
}

function ctx(deps: SessionsDeps): HandlerCtx<SessionsDeps> {
  return { deps, caller: { id: "1", callerClass: "local" } };
}

describe("sessions.list", () => {
  const local = { list: async () => [session("mine", "2026-10-27T10:00:00.000Z")] };

  it("answers with this host's Sessions alone when no host is adopted", async () => {
    expect(await sessionsList(ctx({ sessionScanner: local }))).toEqual([
      session("mine", "2026-10-27T10:00:00.000Z"),
    ]);
  });

  it("merges every adopted host's Sessions, each with its host's id, newest first", async () => {
    // The host server knows itself as `local`; the proxy's answer names it.
    const box = proxy("box", async () => [session("theirs", "2026-10-28T09:00:00.000Z")]);
    const list = await sessionsList(ctx({ sessionScanner: local, hostRouting: routing([box]) }));
    expect(list.map((s) => [s.hostId, s.sessionId])).toEqual([
      ["box", "theirs"],
      ["local", "mine"],
    ]);
  });

  it("gives no Sessions for a host that is away or too old to list them", async () => {
    const box = proxy("box", async () => [session("theirs", "2026-10-26T09:00:00.000Z")]);
    const old = proxy("old", async () => {
      throw new Error('unknown method "sessions.list"');
    });
    const away = proxy("away", async () => {
      throw new HostServerUnavailableError("away", "idle", "away is offline");
    });
    const list = await sessionsList(
      ctx({ sessionScanner: local, hostRouting: routing([old, box, away]) }),
    );
    expect(list.map((s) => [s.hostId, s.sessionId])).toEqual([
      ["local", "mine"],
      ["box", "theirs"],
    ]);
  });

  it("is on the host server's table, so the desktop can ask a host for it", () => {
    expect("sessions.list" in HOST_TABLE.handlers).toBe(true);
  });
});
