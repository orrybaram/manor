/**
 * A desktop window's `Pipe` to one host server: its own
 * `manor-host server-bridge --viewer` stream, which main opens over the
 * host's SSH session and carries as text (`electron/ipc/host-pipe.ts`).
 *
 * `./ws.ts` runs over it as it runs over the relay, with one difference it is
 * told about: `server-bridge` said the hello on the box, so the transport
 * sends none and takes the stream's first line — the server's hello reply —
 * as its handshake (`preAuthenticated`). The owner token never leaves the
 * box.
 *
 * **Close codes.** Main ends every pipe with `CLOSE_HOST_UNREACHABLE`: the
 * host is not adopted, its server is too old for a viewer stream, the host
 * was lost, or the stream ended. All of it is reachability, so it is listed
 * in `unreachableCodes` and the transport retries with backoff and says so.
 *
 * **Liveness is main's.** There is no heartbeat on this line: the ssh child
 * exiting, or the host leaving `connected` (which a wake from sleep checks),
 * closes the pipe from main's side. So `probe` reports whether the
 * pipe is still open, and nothing more. A server that is open but silent is
 * the transport's to notice: it pings one quiet for long enough,
 * which a live host server answers in milliseconds.
 */

import { CLOSE_HOST_UNREACHABLE } from "../../../electron/bridge/types";
import type { NativeApi } from "../../../electron/preload";
import {
  createWsTransport,
  type Pipe,
  type PipeConnection,
  type WsBridgeTransport,
  type WsTransportOptions,
} from "./ws";

/** `window.manorHost.native.hostPipe`, or a fake of it. */
export type HostPipeApi = NativeApi["hostPipe"];

export function hostPipe(api: HostPipeApi, hostId: string): Pipe {
  return {
    unreachableCodes: new Set([CLOSE_HOST_UNREACHABLE]),
    connect(handlers): PipeConnection {
      let pipeId: string | null = null;
      let closed = false;

      // Listening before `open` is asked: main starts the stream only after
      // it has answered with the id, so nothing for this pipe comes earlier.
      const offFrame = api.onFrame((id, text) => {
        if (closed || id !== pipeId) return;
        handlers.onMessage(text);
      });
      const offClosed = api.onClosed((id, code) => {
        if (id === pipeId) finish(code);
      });

      /** Report the close once, and stop listening. */
      const finish = (code: number): void => {
        if (closed) return;
        closed = true;
        offFrame();
        offClosed();
        handlers.onClose(code);
      };

      api.open(hostId).then(
        (id) => {
          // Given up on before main answered: let main's end go too.
          if (closed) {
            api.close(id);
            return;
          }
          pipeId = id;
          handlers.onOpen();
        },
        () => finish(CLOSE_HOST_UNREACHABLE),
      );

      const isOpen = (): boolean => !closed && pipeId !== null;

      return {
        get open() {
          return isOpen();
        },
        send(text) {
          if (!isOpen() || pipeId === null) {
            throw new Error("host pipe is not open");
          }
          api.send(pipeId, text);
        },
        probe() {
          return Promise.resolve(isOpen());
        },
        close() {
          if (pipeId !== null && !closed) api.close(pipeId);
          finish(CLOSE_HOST_UNREACHABLE);
        },
      };
    },
  };
}

/**
 * The bridge transport for one host server, over this window's `hostPipe`.
 * Dials on first use, like every `createWsTransport`.
 */
export function createHostPipeTransport(
  api: HostPipeApi,
  hostId: string,
  options: Pick<WsTransportOptions, "onHello" | "onStatus"> = {},
): WsBridgeTransport {
  return createWsTransport({
    ...options,
    token: null,
    preAuthenticated: true,
    pipe: hostPipe(api, hostId),
  });
}
