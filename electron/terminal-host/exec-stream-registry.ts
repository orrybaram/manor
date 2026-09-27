/**
 * ExecStreamRegistry — bookkeeping for the client's `execStream`s: the
 * commands it asked the daemon to stream, and routing their stream events
 * back to the caller that started each one.
 */

import { errorMessage } from "../lib/errors";
import type { StreamCommand, StreamEvent } from "./types";

/** Callbacks for one `execStream`, mirroring `Exec.stream` in backend/exec.ts. */
export interface ExecStreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit: (result: { exitCode: number | null; error?: string }) => void;
}

type ExecExit = Parameters<ExecStreamCallbacks["onExit"]>[0];

interface ExecStreamEntry {
  callbacks: ExecStreamCallbacks;
  /** True once the `execStream` command was written to the stream socket. */
  started: boolean;
  finish: (result: ExecExit) => void;
}

/** What the registry needs from the client's stream socket. */
export interface ExecStreamIo {
  /** Resolves once connected (connecting if need be). */
  ready(): Promise<void>;
  /** Write a command to the stream socket; false if it is not writable. */
  send(cmd: StreamCommand): boolean;
}

export class ExecStreamRegistry {
  /** Live streams by execId; their events never reach the client's handlers. */
  private readonly streams = new Map<string, ExecStreamEntry>();
  private execIdCounter = 0;

  constructor(private readonly io: ExecStreamIo) {}

  /** See `TerminalHostClient.execStream`. */
  start(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
    callbacks: ExecStreamCallbacks,
  ): { cancel: () => void } {
    const execId = `exec-${++this.execIdCounter}`;
    let done = false;
    const entry: ExecStreamEntry = {
      callbacks,
      started: false,
      finish: (result) => {
        if (done) return;
        done = true;
        this.streams.delete(execId);
        callbacks.onExit(result);
      },
    };
    this.streams.set(execId, entry);

    this.io.ready().then(
      () => {
        if (done) return;
        entry.started = true;
        const sent = this.io.send({
          type: "execStream",
          execId,
          cmd,
          args,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.env ? { env: opts.env } : {}),
        });
        if (!sent) entry.finish({ exitCode: null, error: "Disconnected" });
      },
      (err: unknown) => {
        entry.finish({ exitCode: null, error: errorMessage(err) });
      },
    );

    return {
      cancel: () => {
        if (done) return;
        if (!entry.started) {
          // Never reached the daemon: nothing to kill, report it as killed.
          entry.finish({ exitCode: null });
          return;
        }
        // The daemon answers with an `execExit` once the child is gone.
        this.io.send({ type: "execCancel", execId });
      },
    };
  }

  /** Route an exec stream event to its caller. False for any other event. */
  dispatch(event: StreamEvent): boolean {
    if (
      event.type !== "execStdout" &&
      event.type !== "execStderr" &&
      event.type !== "execExit"
    ) {
      return false;
    }
    const entry = this.streams.get(event.execId);
    if (!entry) return true;
    if (event.type === "execExit") entry.finish({ exitCode: event.exitCode });
    else if (event.type === "execStdout") entry.callbacks.onStdout?.(event.data);
    else entry.callbacks.onStderr?.(event.data);
    return true;
  }

  /**
   * The stream socket is gone. The daemon kills a closed socket's exec
   * children, so every stream already sent is over — say so rather than
   * leave it hanging. Streams not yet sent carry on once reconnected.
   */
  failAll(reason: string): void {
    for (const entry of [...this.streams.values()]) {
      if (entry.started) entry.finish({ exitCode: null, error: reason });
    }
  }
}
