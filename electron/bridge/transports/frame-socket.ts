/**
 * The seam between the bridge's hello gate and whatever carries its text
 * frames (ADR-206 D5): a relay channel, or a test's in-memory pair.
 */
export interface FrameSocket {
  /** Text frame out. Must not throw; a dead socket drops it. */
  send(text: string): void;
  close(code: number, reason: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  readonly open: boolean;
  /** Hard-kill, after a close the peer may ignore. Optional. */
  terminate?(): void;
  /**
   * How long the hello gate waits for the hello on this socket; defaults to
   * 5 s. A relay channel needs longer (`relay/channel.ts`).
   */
  readonly helloTimeoutMs?: number;
}
