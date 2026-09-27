import { describe, it, expect, vi } from "vitest";
import { createSerializedHandler } from "../control-queue";
import type { ControlRequest } from "../types";

type Req = ControlRequest & { requestId?: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createSerializedHandler", () => {
  it("lets ping and resize complete while a long exec is in flight", async () => {
    const execDone = deferred();
    const completed: string[] = [];

    const handle = createSerializedHandler(
      async (req: Req) => {
        if (req.type === "exec") await execDone.promise;
        completed.push(req.type);
      },
      vi.fn(),
      vi.fn(),
    );

    handle(JSON.stringify({ type: "exec", cmd: "sleep", args: ["60"], requestId: "1" }));
    handle(JSON.stringify({ type: "ping", requestId: "2" }));
    handle(
      JSON.stringify({ type: "resize", sessionId: "s", cols: 80, rows: 24, requestId: "3" }),
    );
    await flush();

    expect(completed).toEqual(["ping", "resize"]);

    execDone.resolve();
    await flush();
    expect(completed).toEqual(["ping", "resize", "exec"]);
  });

  it("keeps ordinary requests serialized", async () => {
    const firstDone = deferred();
    const completed: string[] = [];

    const handle = createSerializedHandler(
      async (req: Req) => {
        if (req.requestId === "1") await firstDone.promise;
        completed.push(req.requestId ?? "");
      },
      vi.fn(),
      vi.fn(),
    );

    handle(JSON.stringify({ type: "getSnapshot", sessionId: "s", requestId: "1" }));
    handle(JSON.stringify({ type: "ping", requestId: "2" }));
    await flush();
    expect(completed).toEqual([]);

    firstDone.resolve();
    await flush();
    expect(completed).toEqual(["1", "2"]);
  });

  it("does not start an exec before an earlier request (e.g. auth) finishes", async () => {
    const authDone = deferred();
    const started: string[] = [];

    const handle = createSerializedHandler(
      async (req: Req) => {
        started.push(req.type);
        if (req.type === "auth") await authDone.promise;
      },
      vi.fn(),
      vi.fn(),
    );

    handle(JSON.stringify({ type: "auth", token: "t", requestId: "1" }));
    handle(JSON.stringify({ type: "exec", cmd: "git", args: [], requestId: "2" }));
    await flush();
    expect(started).toEqual(["auth"]);

    authDone.resolve();
    await flush();
    expect(started).toEqual(["auth", "exec"]);
  });

  it("reports a failing unserialized handler with its requestId", async () => {
    const onError = vi.fn();
    const handle = createSerializedHandler(
      async () => {
        throw new Error("boom");
      },
      onError,
      vi.fn(),
    );

    handle(JSON.stringify({ type: "readFile", path: "/x", requestId: "7" }));
    await flush();
    expect(onError).toHaveBeenCalledWith("7", expect.any(Error));
  });

  it("reports unparseable lines", () => {
    const onInvalidJson = vi.fn();
    const handle = createSerializedHandler(vi.fn(), vi.fn(), onInvalidJson);
    handle("{not json");
    expect(onInvalidJson).toHaveBeenCalledOnce();
  });
});
