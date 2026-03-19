import { describe, it, expect } from "vitest";
import { encodeFrame, encodeJsonFrame, FrameDecoder, MSG } from "./pty-subprocess-ipc";

describe("pty-subprocess-ipc", () => {
  describe("encodeFrame / FrameDecoder roundtrip", () => {
    it("encodes and decodes a simple data frame", () => {
      const payload = Buffer.from("hello world", "utf-8");
      const frame = encodeFrame(MSG.DATA, payload);

      const received: Array<{ type: number; payload: Buffer }> = [];
      const decoder = new FrameDecoder((type, p) => {
        received.push({ type, payload: p });
      });

      decoder.push(frame);

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe(MSG.DATA);
      expect(received[0].payload.toString("utf-8")).toBe("hello world");
    });

    it("handles empty payload", () => {
      const frame = encodeFrame(MSG.READY);

      const received: Array<{ type: number; payload: Buffer }> = [];
      const decoder = new FrameDecoder((type, p) => {
        received.push({ type, payload: p });
      });

      decoder.push(frame);

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe(MSG.READY);
      expect(received[0].payload.length).toBe(0);
    });

    it("handles multiple frames in a single chunk", () => {
      const frame1 = encodeFrame(MSG.DATA, "first");
      const frame2 = encodeFrame(MSG.DATA, "second");
      const combined = Buffer.concat([frame1, frame2]);

      const received: string[] = [];
      const decoder = new FrameDecoder((_, p) => {
        received.push(p.toString("utf-8"));
      });

      decoder.push(combined);

      expect(received).toEqual(["first", "second"]);
    });

    it("handles frames split across chunks", () => {
      const frame = encodeFrame(MSG.DATA, "split across chunks");
      const mid = Math.floor(frame.length / 2);
      const chunk1 = frame.subarray(0, mid);
      const chunk2 = frame.subarray(mid);

      const received: string[] = [];
      const decoder = new FrameDecoder((_, p) => {
        received.push(p.toString("utf-8"));
      });

      decoder.push(chunk1);
      expect(received).toHaveLength(0);

      decoder.push(chunk2);
      expect(received).toEqual(["split across chunks"]);
    });

    it("handles byte-by-byte input", () => {
      const frame = encodeFrame(MSG.WRITE, "byte");

      const received: string[] = [];
      const decoder = new FrameDecoder((_, p) => {
        received.push(p.toString("utf-8"));
      });

      for (let i = 0; i < frame.length; i++) {
        decoder.push(frame.subarray(i, i + 1));
      }

      expect(received).toEqual(["byte"]);
    });
  });

  describe("encodeJsonFrame", () => {
    it("encodes JSON data as a frame", () => {
      const data = { cols: 80, rows: 24 };
      const frame = encodeJsonFrame(MSG.RESIZE, data);

      const received: Array<{ type: number; data: unknown }> = [];
      const decoder = new FrameDecoder((type, p) => {
        received.push({ type, data: JSON.parse(p.toString("utf-8")) });
      });

      decoder.push(frame);

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe(MSG.RESIZE);
      expect(received[0].data).toEqual({ cols: 80, rows: 24 });
    });
  });

  describe("FrameDecoder.reset", () => {
    it("clears internal buffer", () => {
      const frame = encodeFrame(MSG.DATA, "hello");
      const mid = 3;

      const received: string[] = [];
      const decoder = new FrameDecoder((_, p) => {
        received.push(p.toString("utf-8"));
      });

      decoder.push(frame.subarray(0, mid));
      decoder.reset();
      // Remaining chunk should not form a valid frame
      decoder.push(frame.subarray(mid));
      expect(received).toHaveLength(0);
    });
  });

  describe("frame format", () => {
    it("has correct header size (5 bytes)", () => {
      const frame = encodeFrame(MSG.READY);
      // 1 byte type + 4 bytes length + 0 bytes payload
      expect(frame.length).toBe(5);
    });

    it("type byte is first byte", () => {
      const frame = encodeFrame(MSG.SPAWN, "test");
      expect(frame[0]).toBe(MSG.SPAWN);
    });

    it("length is big-endian uint32", () => {
      const payload = "test";
      const frame = encodeFrame(MSG.DATA, payload);
      const len = frame.readUInt32BE(1);
      expect(len).toBe(Buffer.from(payload).length);
    });
  });
});
