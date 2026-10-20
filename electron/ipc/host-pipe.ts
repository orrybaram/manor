import { ipcMain, type WebContents } from "electron";
import type { Duplex } from "node:stream";
import { assertString } from "../ipc-validate";
import { createLineReader } from "../terminal-host/line-reader";
import {
  CLOSE_HOST_UNREACHABLE,
  HOST_PIPE_CLOSE,
  HOST_PIPE_CLOSED,
  HOST_PIPE_FRAME,
  HOST_PIPE_OPEN,
  HOST_PIPE_SEND,
} from "../bridge/types";
import type { HostStatusInfo } from "../backend/host-connection";
import { isRendererSender } from "../bridge/transports/ipc";
import type { HostDeps } from "./types";

/**
 * A window's own streams to host servers: `hostPipe` in the
 * preload, one `manor-host server-bridge --viewer` child per window per
 * host, through the host's transport — so on the ControlMaster its owner
 * channel and daemon streams already share.
 *
 * **Main carries frames and nothing else.** The stream's NDJSON is split
 * into lines and each line goes to the window as it is; a frame from the
 * window goes onto the stream as it is. Nothing here parses one. The hello
 * was said by `server-bridge` on the box, and its reply is the stream's
 * first line, which the window's transport reads as its handshake
 * (`preAuthenticated`, `src/bridge/transports/ws.ts`).
 *
 * **Every way a pipe ends, it ends as `CLOSE_HOST_UNREACHABLE`**, which the
 * renderer's pipe (`src/bridge/transports/host-pipe.ts`) lists as
 * unreachable: its transport says so and retries with backoff. That covers
 * a host that is not adopted or whose server is too old for a viewer stream
 * (refused at `open`), one that drops (`hostLost`), and a stream that ends
 * on its own. A window that closes a pipe itself is not told: it already
 * knows.
 *
 * Pipes belong to the window that opened them. They close with it, and a
 * window can send on or close only its own.
 */

/** Where a pipe's frames go: a window, as far as this file needs one. */
export interface PipeOwner {
  /** `webContents.id`. */
  readonly id: number;
  /** `webContents.send`; never called once the owner is gone. */
  emit(channel: string, ...args: unknown[]): void;
}

export interface HostPipesOptions {
  /**
   * May a window have its own stream to this host now: connected, adopted,
   * and its server reports `viewer-bridge`?
   */
  canOpen(hostId: string): boolean;
  /** Spawn the viewer stream (`HostProvider.openViewerChannel`). */
  openViewer(hostId: string): Promise<Duplex>;
  log?: (message: string) => void;
}

interface OpenPipe {
  readonly pipeId: string;
  readonly hostId: string;
  readonly owner: PipeOwner;
  stream: Duplex | null;
  /** Frames sent before the stream was up, in order. */
  readonly queued: string[];
  done: boolean;
}

export class HostPipes {
  private nextId = 1;
  private readonly pipes = new Map<string, OpenPipe>();
  private readonly log: (message: string) => void;

  constructor(private readonly opts: HostPipesOptions) {
    this.log = opts.log ?? ((message) => console.log(`[host-pipe] ${message}`));
  }

  /**
   * A new pipe to `hostId` for `owner`, answered with its id at once. The
   * stream is started only after this returns — on a later turn — so the
   * window has the id in hand before the first `frame` or `closed` for it
   * can arrive: both travel the same channel to it, in order.
   */
  open(owner: PipeOwner, hostId: string): string {
    const pipe: OpenPipe = {
      pipeId: `${owner.id}-${this.nextId++}`,
      hostId,
      owner,
      stream: null,
      queued: [],
      done: false,
    };
    this.pipes.set(pipe.pipeId, pipe);
    setImmediate(() => void this.start(pipe));
    return pipe.pipeId;
  }

  /** One frame from `ownerId` onto its pipe. Anything else is dropped. */
  send(ownerId: number, pipeId: string, text: string): void {
    const pipe = this.owned(ownerId, pipeId);
    // A frame is one line: a newline inside one would split it in two.
    if (!pipe || text.includes("\n")) return;
    if (pipe.stream) pipe.stream.write(`${text}\n`);
    else pipe.queued.push(text);
  }

  /** `ownerId` is done with its pipe. It is not told it closed. */
  close(ownerId: number, pipeId: string): void {
    const pipe = this.owned(ownerId, pipeId);
    if (pipe) this.finish(pipe, null);
  }

  /**
   * The window is gone, or its page is: so is every pipe it held. `code`
   * tells the window, for a page that may still be there.
   */
  dropOwner(ownerId: number, code: number | null = null): void {
    for (const pipe of [...this.pipes.values()]) {
      if (pipe.owner.id === ownerId) this.finish(pipe, code);
    }
  }

  /** The host is gone (`hostLost`, or unregistered): every pipe to it ends. */
  hostGone(hostId: string): void {
    for (const pipe of [...this.pipes.values()]) {
      if (pipe.hostId === hostId) this.finish(pipe, CLOSE_HOST_UNREACHABLE);
    }
  }

  /** The hosts any pipe is open to. */
  hosts(): Set<string> {
    return new Set([...this.pipes.values()].map((pipe) => pipe.hostId));
  }

  /** End every pipe, telling no one: the app is quitting. */
  dispose(): void {
    for (const pipe of [...this.pipes.values()]) this.finish(pipe, null);
  }

  private owned(ownerId: number, pipeId: string): OpenPipe | null {
    const pipe = this.pipes.get(pipeId);
    return pipe && pipe.owner.id === ownerId ? pipe : null;
  }

  private async start(pipe: OpenPipe): Promise<void> {
    if (pipe.done) return;
    if (!this.opts.canOpen(pipe.hostId)) {
      this.finish(pipe, CLOSE_HOST_UNREACHABLE);
      return;
    }
    let stream: Duplex;
    try {
      stream = await this.opts.openViewer(pipe.hostId);
    } catch (err) {
      this.log(`${pipe.hostId}: viewer stream failed: ${(err as Error).message}`);
      this.finish(pipe, CLOSE_HOST_UNREACHABLE);
      return;
    }
    if (pipe.done) {
      stream.destroy();
      return;
    }
    pipe.stream = stream;
    stream.on(
      "data",
      createLineReader((line) => {
        if (!pipe.done) pipe.owner.emit(HOST_PIPE_FRAME, pipe.pipeId, line);
      }),
    );
    stream.on("error", (err) => {
      this.log(`${pipe.hostId}: viewer stream: ${err.message}`);
    });
    stream.on("close", () => this.finish(pipe, CLOSE_HOST_UNREACHABLE));
    for (const text of pipe.queued.splice(0)) stream.write(`${text}\n`);
  }

  /** End `pipe` once; `code` null tells its window nothing. */
  private finish(pipe: OpenPipe, code: number | null): void {
    if (pipe.done) return;
    pipe.done = true;
    this.pipes.delete(pipe.pipeId);
    pipe.queued.length = 0;
    pipe.stream?.destroy();
    if (code !== null) pipe.owner.emit(HOST_PIPE_CLOSED, pipe.pipeId, code);
  }
}

/** Whether a window may stream straight to `host`'s server. */
export function viewerStreamable(
  host: HostStatusInfo | undefined,
  adopted: boolean,
): boolean {
  return host?.status === "connected" && host.viewerBridge === true && adopted;
}

/** A window, as a `PipeOwner`. */
function ownerOf(sender: WebContents): PipeOwner {
  return {
    id: sender.id,
    emit: (channel, ...args) => {
      if (!sender.isDestroyed()) sender.send(channel, ...args);
    },
  };
}

export function register(deps: HostDeps): HostPipes {
  const { backendRegistry, projectManager } = deps;
  const pipes = new HostPipes({
    canOpen: (hostId) =>
      viewerStreamable(
        backendRegistry.list().find((host) => host.hostId === hostId),
        projectManager.isHostAdopted(hostId),
      ),
    openViewer: (hostId) => {
      const provider = backendRegistry.provider(hostId);
      if (!provider?.openViewerChannel) {
        return Promise.reject(new Error(`${hostId} has no viewer stream`));
      }
      return provider.openViewerChannel();
    },
  });

  // `hostLost`: a host that leaves `connected` takes its owner channel down
  // (`RemoteHostConnection.setState`), and its windows' streams with it. One
  // that was unregistered is not in the list at all.
  backendRegistry.onStatusChange((hosts) => {
    for (const hostId of pipes.hosts()) {
      const host = hosts.find((h) => h.hostId === hostId);
      if (host?.status !== "connected") pipes.hostGone(hostId);
    }
  });

  /** Windows whose `destroyed` is already being listened for. */
  const watched = new Set<number>();

  /**
   * The same door as the bridge's own channels (`isRendererSender`): a
   * viewer stream is the owner's credential on a host, so a `<webview>`
   * guest may not open one.
   */
  const fromWindow = (sender: WebContents, channel: string): boolean => {
    if (isRendererSender(sender, deps.getRendererWindows())) return true;
    console.warn(
      `[host-pipe] ${channel} from an unrecognised sender (webContents ${sender.id}) — dropped`,
    );
    return false;
  };

  ipcMain.handle(HOST_PIPE_OPEN, (event, hostId: unknown) => {
    assertString(hostId, "hostId");
    const sender = event.sender;
    if (!fromWindow(sender, HOST_PIPE_OPEN)) {
      throw new Error("hostPipe is only for Manor's own windows");
    }
    // Read once: `destroyed` fires with the native object already gone.
    const ownerId = sender.id;
    if (!watched.has(ownerId)) {
      watched.add(ownerId);
      sender.once("destroyed", () => {
        watched.delete(ownerId);
        pipes.dropOwner(ownerId);
      });
      // A reload replaces the page, not the window: the page that held these
      // pipes is going. Told, not just dropped, in case the navigation is
      // cancelled and the page stays — its transport then dials again.
      sender.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
          pipes.dropOwner(ownerId, CLOSE_HOST_UNREACHABLE);
        }
      });
    }
    return pipes.open(ownerOf(sender), hostId);
  });

  ipcMain.on(HOST_PIPE_SEND, (event, pipeId: unknown, text: unknown) => {
    if (typeof pipeId !== "string" || typeof text !== "string") return;
    pipes.send(event.sender.id, pipeId, text);
  });

  ipcMain.on(HOST_PIPE_CLOSE, (event, pipeId: unknown) => {
    if (typeof pipeId !== "string") return;
    pipes.close(event.sender.id, pipeId);
  });

  return pipes;
}
