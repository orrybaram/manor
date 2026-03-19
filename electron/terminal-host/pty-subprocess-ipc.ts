/**
 * Binary frame protocol between daemon and PTY subprocess.
 *
 * Frame layout: [type: 1 byte] [payload length: 4 bytes BE] [payload: N bytes]
 *
 * Daemon → Subprocess message types (0x01–0x0F):
 *   0x01 Spawn   — JSON: PtySpawnPayload
 *   0x02 Write   — raw bytes (terminal input)
 *   0x03 Resize  — JSON: { cols, rows }
 *   0x04 Kill    — no payload
 *   0x05 Signal  — JSON: { signal }
 *   0x06 Dispose — no payload
 *
 * Subprocess → Daemon message types (0x11–0x1F):
 *   0x11 Ready   — no payload (subprocess started, waiting for Spawn)
 *   0x12 Spawned — JSON: { pid }
 *   0x13 Data    — raw bytes (terminal output)
 *   0x14 Exit    — JSON: { exitCode }
 *   0x15 Error   — JSON: { message }
 *   0x16 FgProc  — JSON: { name } (foreground process name, polled)
 */

// ── Message type constants ──

export const MSG = {
  // Daemon → Subprocess
  SPAWN: 0x01,
  WRITE: 0x02,
  RESIZE: 0x03,
  KILL: 0x04,
  SIGNAL: 0x05,
  DISPOSE: 0x06,

  // Subprocess → Daemon
  READY: 0x11,
  SPAWNED: 0x12,
  DATA: 0x13,
  EXIT: 0x14,
  ERROR: 0x15,
  FGPROC: 0x16,
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

const HEADER_SIZE = 5;

/** Encode a frame: 1-byte type + 4-byte BE length + payload */
export function encodeFrame(type: MessageType, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const frame = Buffer.allocUnsafe(HEADER_SIZE + buf.length);
  frame[0] = type;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, HEADER_SIZE);
  return frame;
}

/** Encode a JSON payload as a frame */
export function encodeJsonFrame(type: MessageType, data: unknown): Buffer {
  return encodeFrame(type, JSON.stringify(data));
}

/**
 * Streaming frame decoder. Feed it chunks and it emits complete frames.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private onFrame: (type: MessageType, payload: Buffer) => void;

  constructor(onFrame: (type: MessageType, payload: Buffer) => void) {
    this.onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLen = this.buffer.readUInt32BE(1);
      const totalLen = HEADER_SIZE + payloadLen;

      if (this.buffer.length < totalLen) break;

      const type = this.buffer[0] as MessageType;
      const payload = this.buffer.subarray(HEADER_SIZE, totalLen);

      // Advance buffer
      this.buffer = this.buffer.subarray(totalLen);

      this.onFrame(type, Buffer.from(payload));
    }
  }

  /** Reset internal buffer */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
