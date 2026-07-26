import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Mock electron ──

const mockWebContents: Record<string, unknown> = {
  getURL: vi.fn(() => "https://example.com"),
  getTitle: vi.fn(() => "Example Page"),
  capturePage: vi.fn(),
  executeJavaScript: vi.fn(),
  loadURL: vi.fn(),
  sendInputEvent: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getMediaSourceId: vi.fn(() => "media-source-1"),
  isFocused: vi.fn(() => true),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn(),
  },
}));

// ── Mock the recording round-trip to the renderer (ADR-158) ──
//
// `RecordingManager` itself has no Electron dependency (see its own file
// header), so it is used for real here to exercise `start()`/`stop()`/`list()`
// against a fresh instance. Only the renderer round-trip — which genuinely
// crosses a process boundary this test cannot simulate — and the pane→renderer
// webContents lookup are doubled.
vi.mock("../ipc/webview", async () => {
  const { RecordingManager } = await import("../recording-manager");
  return {
    recordingManager: new RecordingManager(),
    startRendererRecording: vi.fn(),
    stopRecording: vi.fn(),
    getPaneRendererWebContents: vi.fn(),
  };
});

import { WebviewServer } from "../webview-server";
import { webContents } from "electron";
import {
  recordingManager,
  startRendererRecording,
  stopRecording,
  getPaneRendererWebContents,
} from "../ipc/webview";

// ── HTTP helper ──

function httpRequest(
  port: number,
  method: string,
  reqPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error("timeout"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function httpGet(port: number, reqPath: string) {
  return httpRequest(port, "GET", reqPath);
}

function httpPost(
  port: number,
  reqPath: string,
  body?: Record<string, unknown>,
) {
  return httpRequest(port, "POST", reqPath, body);
}

// ── Tests ──

describe("WebviewServer", () => {
  let server: WebviewServer;
  let registry: Map<string, number>;

  beforeEach(async () => {
    registry = new Map<string, number>();
    registry.set("pane-1", 101);
    registry.set("pane-2", 102);

    // Configure mock
    (webContents.fromId as ReturnType<typeof vi.fn>).mockImplementation(
      (id: number) => {
        if (id === 101 || id === 102) return mockWebContents;
        return null;
      },
    );

    // Reset all mocks on the webContents object
    for (const key of Object.keys(mockWebContents)) {
      const fn = mockWebContents[key] as ReturnType<typeof vi.fn>;
      fn.mockClear();
    }
    (mockWebContents.getURL as ReturnType<typeof vi.fn>).mockReturnValue(
      "https://example.com",
    );
    (mockWebContents.getTitle as ReturnType<typeof vi.fn>).mockReturnValue(
      "Example Page",
    );
    (mockWebContents.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    (mockWebContents.capturePage as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        toPNG: () => Buffer.from("fakepng"),
      },
    );
    (
      mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
    ).mockResolvedValue("result");
    (mockWebContents.getMediaSourceId as ReturnType<typeof vi.fn>).mockReturnValue(
      "media-source-1",
    );
    (mockWebContents.isFocused as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    (mockWebContents.loadURL as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    (startRendererRecording as Mock).mockReset().mockResolvedValue({ ok: true });
    (stopRecording as Mock).mockReset();
    (getPaneRendererWebContents as Mock)
      .mockReset()
      .mockReturnValue(mockWebContents);

    server = new WebviewServer(registry);
    await server.start();
  });

  afterEach(async () => {
    server.stop();
    await recordingManager.stopAll();
  });

  // ── Server lifecycle ──

  describe("Server lifecycle", () => {
    it("assigns a port > 0 on start", () => {
      expect(server.serverPort).toBeGreaterThan(0);
    });

    it("writes port file", () => {
      const portFile = path.join(
        process.env.HOME || "/tmp",
        ".manor",
        "webview-server-port",
      );
      expect(fs.existsSync(portFile)).toBe(true);
      const content = fs.readFileSync(portFile, "utf-8");
      expect(parseInt(content, 10)).toBe(server.serverPort);
    });

    it("stop() cleans up port file", () => {
      const portFile = path.join(
        process.env.HOME || "/tmp",
        ".manor",
        "webview-server-port",
      );
      server.stop();
      expect(fs.existsSync(portFile)).toBe(false);
    });

    it("supports multiple start/stop cycles", async () => {
      server.stop();

      await server.start();
      expect(server.serverPort).toBeGreaterThan(0);
      const _port1 = server.serverPort;

      server.stop();

      await server.start();
      expect(server.serverPort).toBeGreaterThan(0);
      // Port may differ, but must be valid
      expect(typeof server.serverPort).toBe("number");
    });
  });

  // ── GET /webviews ──

  describe("GET /webviews", () => {
    it("returns empty array when no webviews registered", async () => {
      registry.clear();
      const res = await httpGet(server.serverPort, "/webviews");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("returns correct paneId, url, title for registered webviews", async () => {
      const res = await httpGet(server.serverPort, "/webviews");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(2);
      expect(data[0]).toEqual({
        paneId: "pane-1",
        url: "https://example.com",
        title: "Example Page",
      });
      expect(data[1]).toEqual({
        paneId: "pane-2",
        url: "https://example.com",
        title: "Example Page",
      });
    });
  });

  // ── POST /webview/:id/screenshot ──

  describe("POST /webview/:id/screenshot", () => {
    it("returns 404 when paneId not in registry", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/unknown-pane/screenshot",
      );
      expect(res.status).toBe(404);
    });

    it("returns base64 PNG image data for valid paneId", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/screenshot",
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.image).toBe(Buffer.from("fakepng").toString("base64"));
    });
  });

  // ── POST /webview/:id/record/start, /record/stop, GET /recordings ──

  describe("Recording routes", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "manor-webview-server-test-"),
      );
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    function outPath(name: string): string {
      return path.join(tmpDir, name);
    }

    describe("POST /webview/:id/record/start", () => {
      it("returns a recordingId and path on success", async () => {
        const res = await httpPost(
          server.serverPort,
          "/webview/pane-1/record/start",
          { path: outPath("clip.webm") },
        );
        expect(res.status).toBe(200);
        const data = JSON.parse(res.body);
        expect(typeof data.recordingId).toBe("string");
        expect(data.path).toBe(outPath("clip.webm"));
        expect(data.warning).toBeUndefined();

        expect(startRendererRecording).toHaveBeenCalledWith(
          data.recordingId,
          "pane-1",
          "media-source-1",
        );

        const active = recordingManager.list();
        expect(active).toHaveLength(1);
        expect(active[0].recordingId).toBe(data.recordingId);
      });

      it("returns 404 for an unknown paneId", async () => {
        const res = await httpPost(
          server.serverPort,
          "/webview/unknown-pane/record/start",
          {},
        );
        expect(res.status).toBe(404);
      });

      it("rolls back and leaves no recording when the renderer fails to start", async () => {
        (startRendererRecording as Mock).mockResolvedValue({
          ok: false,
          error: "getUserMedia failed",
        });

        const res = await httpPost(
          server.serverPort,
          "/webview/pane-1/record/start",
          { path: outPath("clip.webm") },
        );
        expect(res.status).toBe(500);
        const data = JSON.parse(res.body);
        expect(data.error).toContain("getUserMedia failed");

        expect(recordingManager.list()).toHaveLength(0);
      });
    });

    describe("POST /webview/:id/record/stop", () => {
      it("returns path, duration, bytes and keyframes", async () => {
        (stopRecording as Mock).mockResolvedValue({
          recordingId: "rec-1",
          paneId: "pane-1",
          path: outPath("clip.webm"),
          durationMs: 1234,
          bytes: 42,
          keyframes: ["AAAA"],
          alreadyStopped: false,
        });

        const res = await httpPost(
          server.serverPort,
          "/webview/pane-1/record/stop",
          { recordingId: "rec-1" },
        );
        expect(res.status).toBe(200);
        const data = JSON.parse(res.body);
        expect(data).toEqual({
          path: outPath("clip.webm"),
          durationMs: 1234,
          bytes: 42,
          keyframes: ["AAAA"],
        });
        expect(stopRecording).toHaveBeenCalledWith("rec-1", expect.any(Number));
      });

      it("returns 404 for an unknown recordingId", async () => {
        (stopRecording as Mock).mockResolvedValue(null);

        const res = await httpPost(
          server.serverPort,
          "/webview/pane-1/record/stop",
          { recordingId: "no-such-id" },
        );
        expect(res.status).toBe(404);
      });
    });

    describe("GET /recordings", () => {
      it("lists active recordings", async () => {
        const started = recordingManager.start({
          paneId: "pane-1",
          path: outPath("active.webm"),
          capture: async () => "AAAA",
        });

        const res = await httpGet(server.serverPort, "/recordings");
        expect(res.status).toBe(200);
        const data = JSON.parse(res.body);
        expect(data).toHaveLength(1);
        expect(data[0].recordingId).toBe(started.recordingId);
        expect(data[0].paneId).toBe("pane-1");
        expect(data[0].path).toBe(outPath("active.webm"));
        expect(typeof data[0].elapsedMs).toBe("number");
      });
    });
  });

  // ── POST /webview/:id/execute-js ──

  describe("POST /webview/:id/execute-js", () => {
    it("returns result of executeJavaScript call", async () => {
      (
        mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
      ).mockResolvedValue(42);
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/execute-js",
        {
          code: "1 + 1",
        },
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: 42 });
    });

    it("returns error when JS throws", async () => {
      (
        mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("ReferenceError: foo is not defined"));
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/execute-js",
        {
          code: "foo()",
        },
      );
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("ReferenceError");
    });

    it("returns 400 when code is missing", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/execute-js",
        {},
      );
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("code");
    });
  });

  // ── POST /webview/:id/dom ──

  describe("POST /webview/:id/dom", () => {
    it("returns HTML string from the webview", async () => {
      (
        mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
      ).mockResolvedValue("<div><p>Hello</p></div>");
      const res = await httpPost(server.serverPort, "/webview/pane-1/dom");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.html).toBe("<div><p>Hello</p></div>");
    });
  });

  // ── POST /webview/:id/click ──

  describe("POST /webview/:id/click", () => {
    it("calls sendInputEvent with mouseDown and mouseUp for x,y coordinates", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/click", {
        x: 100,
        y: 200,
      });
      expect(res.status).toBe(200);
      const sendInputEvent = mockWebContents.sendInputEvent as ReturnType<
        typeof vi.fn
      >;
      expect(sendInputEvent).toHaveBeenCalledTimes(2);
      expect(sendInputEvent).toHaveBeenNthCalledWith(1, {
        type: "mouseDown",
        x: 100,
        y: 200,
        button: "left",
      });
      expect(sendInputEvent).toHaveBeenNthCalledWith(2, {
        type: "mouseUp",
        x: 100,
        y: 200,
        button: "left",
      });
    });

    it("returns 400 when neither selector nor coordinates provided", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/click",
        {},
      );
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("selector");
    });
  });

  // ── POST /webview/:id/type ──

  describe("POST /webview/:id/type", () => {
    it("sends char input events for each character", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/type", {
        text: "abc",
      });
      expect(res.status).toBe(200);
      const sendInputEvent = mockWebContents.sendInputEvent as ReturnType<
        typeof vi.fn
      >;
      expect(sendInputEvent).toHaveBeenCalledTimes(3);
      expect(sendInputEvent).toHaveBeenNthCalledWith(1, {
        type: "char",
        keyCode: "a",
      });
      expect(sendInputEvent).toHaveBeenNthCalledWith(2, {
        type: "char",
        keyCode: "b",
      });
      expect(sendInputEvent).toHaveBeenNthCalledWith(3, {
        type: "char",
        keyCode: "c",
      });
    });

    it("returns 400 when text is missing", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/type", {});
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("text");
    });
  });

  // ── POST /webview/:id/navigate ──

  describe("POST /webview/:id/navigate", () => {
    it("calls loadURL with the provided URL", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/navigate",
        {
          url: "https://google.com",
        },
      );
      expect(res.status).toBe(200);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith(
        "https://google.com",
      );
    });

    it("returns 400 for missing url", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/navigate",
        {},
      );
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("url");
    });
  });

  // ── GET /webview/:id/console-logs ──

  describe("GET /webview/:id/console-logs", () => {
    it("returns empty array when no logs buffered", async () => {
      const res = await httpGet(
        server.serverPort,
        "/webview/pane-1/console-logs",
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });
  });

  // ── GET /webview/:id/url ──

  describe("GET /webview/:id/url", () => {
    it("returns current URL from getURL()", async () => {
      (mockWebContents.getURL as ReturnType<typeof vi.fn>).mockReturnValue(
        "https://specific-page.com/path",
      );
      const res = await httpGet(server.serverPort, "/webview/pane-1/url");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.url).toBe("https://specific-page.com/path");
    });
  });

  // ── Error handling ──

  describe("Error handling", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await httpGet(server.serverPort, "/foo/bar");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown paneId", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/no-such-pane/screenshot",
      );
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("not found");
    });

    it("returns 410 when webContents is destroyed", async () => {
      (webContents.fromId as ReturnType<typeof vi.fn>).mockImplementation(
        (id: number) => {
          if (id === 101)
            return { ...mockWebContents, isDestroyed: () => true };
          return mockWebContents;
        },
      );
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/screenshot",
      );
      expect(res.status).toBe(410);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("destroyed");
    });
  });
});
