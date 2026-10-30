import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Mock electron ──

/** Backs `getZoomLevel`/`setZoomLevel` so the zoom routes can be read back. */
let zoomLevel = 0;

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
  setZoomLevel: vi.fn((level: number) => {
    zoomLevel = level;
  }),
  getZoomLevel: vi.fn(() => zoomLevel),
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
  setAudioMuted: vi.fn(),
  stop: vi.fn(),
};

vi.mock("electron", () => ({
  app: { isPackaged: false },
  webContents: {
    fromId: vi.fn(),
  },
}));

// ── Mock the recording round-trip to the renderer ──
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
import { runCli } from "../mcp/cli";
import { createHttp } from "../mcp/http-client";
import type { HostDeps } from "../ipc/types";
import { webContents } from "electron";
import {
  recordingManager,
  startRendererRecording,
  stopRecording,
  getPaneRendererWebContents,
} from "../ipc/webview";

// ── HTTP helper ──

/** The running server's token; set in `beforeEach`. */
let controlToken = "";

function httpRequest(
  port: number,
  method: string,
  reqPath: string,
  body?: Record<string, unknown>,
  headers: http.OutgoingHttpHeaders = {
    "x-manor-control-token": controlToken,
    "Content-Type": "application/json",
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers,
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
  /** What a test adds to the deps the routes run over. */
  let extraDeps: Partial<HostDeps>;
  let registry: Map<string, number>;

  beforeEach(async () => {
    zoomLevel = 0;
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
    (
      mockWebContents.getMediaSourceId as ReturnType<typeof vi.fn>
    ).mockReturnValue("media-source-1");
    (mockWebContents.isFocused as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    (mockWebContents.loadURL as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    (startRendererRecording as Mock)
      .mockReset()
      .mockResolvedValue({ ok: true });
    (stopRecording as Mock).mockReset();
    (getPaneRendererWebContents as Mock)
      .mockReset()
      .mockReturnValue(mockWebContents);

    // The webview routes reach their panes through the server itself, as
    // `app-lifecycle.ts` wires it; a test adds what else a route reads.
    extraDeps = {};
    const built: WebviewServer = new WebviewServer(
      registry,
      () =>
        ({
          webviewServer: built,
          webviewPanes: built,
          ...extraDeps,
        }) as unknown as HostDeps,
    );
    server = built;
    await server.start();
    controlToken = server.controlToken;
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

  // ── Request checks ──

  describe("Request checks", () => {
    const tokenFile = () =>
      path.join(process.env.HOME || "/tmp", ".manor", "webview-server-token");

    it("writes a token file readable only by this user", () => {
      expect(server.controlToken).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(tokenFile(), "utf-8")).toBe(server.controlToken);
      expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    });

    it("stop() removes the token file", () => {
      server.stop();
      expect(fs.existsSync(tokenFile())).toBe(false);
    });

    it("mints a fresh token on each start", async () => {
      const first = server.controlToken;
      server.stop();
      await server.start();
      expect(server.controlToken).not.toBe(first);
    });

    it("answers a request with the token, a loopback Host and no Origin", async () => {
      const res = await httpGet(server.serverPort, "/webviews");
      expect(res.status).toBe(200);
    });

    it("accepts localhost as the Host", async () => {
      const res = await httpRequest(server.serverPort, "GET", "/webviews", undefined, {
        Host: `localhost:${server.serverPort}`,
        "x-manor-control-token": controlToken,
      });
      expect(res.status).toBe(200);
    });

    it("refuses a request with no token", async () => {
      const res = await httpRequest(server.serverPort, "GET", "/webviews", undefined, {});
      expect(res.status).toBe(401);
    });

    it("refuses a request with the wrong token", async () => {
      const res = await httpRequest(server.serverPort, "GET", "/webviews", undefined, {
        "x-manor-control-token": "0".repeat(64),
      });
      expect(res.status).toBe(401);
    });

    it("refuses a Host other than this listener's loopback address", async () => {
      for (const host of [
        "example.com",
        `example.com:${server.serverPort}`,
        "127.0.0.1",
        `127.0.0.1:${server.serverPort + 1}`,
      ]) {
        const res = await httpRequest(server.serverPort, "GET", "/webviews", undefined, {
          Host: host,
          "x-manor-control-token": controlToken,
        });
        expect(res.status, host).toBe(403);
      }
    });

    it("refuses any request that carries an Origin, even with the token", async () => {
      for (const origin of ["https://example.com", "null", `http://127.0.0.1:${server.serverPort}`]) {
        const res = await httpRequest(server.serverPort, "GET", "/webviews", undefined, {
          Origin: origin,
          "x-manor-control-token": controlToken,
        });
        expect(res.status, origin).toBe(403);
      }
    });

    it("refuses a POST whose body isn't declared JSON, without running the route", async () => {
      for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
        const res = await httpRequest(
          server.serverPort,
          "POST",
          "/webview/pane-1/navigate",
          { url: "https://example.org" },
          {
            "x-manor-control-token": controlToken,
            ...(contentType ? { "Content-Type": contentType } : {}),
          },
        );
        expect(res.status, String(contentType)).toBe(415);
      }
      expect(mockWebContents.loadURL).not.toHaveBeenCalled();
    });

    it("refuses a DELETE whose body isn't declared JSON", async () => {
      const res = await httpRequest(server.serverPort, "DELETE", "/panes/pane-1", undefined, {
        "x-manor-control-token": controlToken,
        "Content-Type": "text/plain",
      });
      expect(res.status).toBe(415);
    });

    it("accepts a JSON Content-Type with parameters", async () => {
      const res = await httpRequest(
        server.serverPort,
        "POST",
        "/webview/pane-1/navigate",
        { url: "https://example.org" },
        {
          "x-manor-control-token": controlToken,
          "Content-Type": "application/json; charset=utf-8",
        },
      );
      expect(res.status).toBe(200);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith("https://example.org");
    });
  });

  // ── The manor CLI, end to end ──

  describe("manor CLI against the running server", () => {
    function cliIo() {
      let stdout = "";
      let stderr = "";
      return {
        io: {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) },
          stdin: { read: () => "" },
        },
        out: () => stdout,
        err: () => stderr,
      };
    }

    beforeEach(() => {
      delete process.env.MANOR_CONTROL_PORT_FILE;
      delete process.env.MANOR_WEBVIEW_PORT;
      delete process.env.MANOR_WEBVIEW_TOKEN;
    });

    it("finds the server through its port and token files and runs a GET", async () => {
      const { io, out, err } = cliIo();
      const code = await runCli(["list-webviews"], createHttp(), io as never);
      expect(err()).toBe("");
      expect(code).toBe(0);
      expect(out()).toContain("pane-1");
    });

    it("runs a POST command through the server's checks", async () => {
      const { io, err } = cliIo();
      const code = await runCli(
        ["navigate", "--pane-id", "pane-1", "--url", "https://example.org"],
        createHttp(),
        io as never,
      );
      expect(err()).toBe("");
      expect(code).toBe(0);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith("https://example.org");
    });

    it("works from the env pairing a Manor terminal is given", async () => {
      process.env.MANOR_WEBVIEW_PORT = String(server.serverPort);
      process.env.MANOR_WEBVIEW_TOKEN = server.controlToken;
      fs.unlinkSync(path.join(process.env.HOME || "/tmp", ".manor", "webview-server-port"));
      const { io, out } = cliIo();
      const code = await runCli(["api", "GET", "/webviews"], createHttp(), io as never);
      expect(code).toBe(0);
      expect(out()).toContain("pane-1");
      delete process.env.MANOR_WEBVIEW_PORT;
      delete process.env.MANOR_WEBVIEW_TOKEN;
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

    it("rewrites a remote pane's URL through resolvePaneUrl", async () => {
      const resolvePaneUrl = vi.fn(async (paneId: string, url: string) =>
        paneId === "pane-1" && url === "http://localhost:3000/"
          ? "http://127.0.0.1:53000/"
          : url,
      );
      extraDeps.resolvePaneUrl = resolvePaneUrl;

      const res = await httpPost(server.serverPort, "/webview/pane-1/navigate", {
        url: "http://localhost:3000/",
      });
      expect(res.status).toBe(200);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith("http://127.0.0.1:53000/");
      expect(resolvePaneUrl).toHaveBeenCalledWith("pane-1", "http://localhost:3000/");

      // A pane resolvePaneUrl doesn't rewrite is loaded as is.
      resolvePaneUrl.mockClear();
      await httpPost(server.serverPort, "/webview/pane-2/navigate", {
        url: "http://localhost:3000/",
      });
      expect(mockWebContents.loadURL).toHaveBeenLastCalledWith("http://localhost:3000/");
    });

    it("answers 503, loading nothing, when the remote host cannot be reached", async () => {
      extraDeps.resolvePaneUrl = async () => {
        throw new Error('Remote host "box" is not connected');
      };
      (mockWebContents.loadURL as Mock).mockClear();

      const res = await httpPost(server.serverPort, "/webview/pane-1/navigate", {
        url: "http://localhost:3000/",
      });
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body).error).toContain("not connected");
      expect(mockWebContents.loadURL).not.toHaveBeenCalled();
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

  // ── Zoom, find, mute, stop ──

  describe("POST /webview/:id/zoom-in | zoom-out | zoom-reset", () => {
    it("steps the zoom level and reports where it landed", async () => {
      const inRes = await httpPost(
        server.serverPort,
        "/webview/pane-1/zoom-in",
      );
      expect(inRes.status).toBe(200);
      expect(JSON.parse(inRes.body).zoomLevel).toBe(0.5);

      const outRes = await httpPost(
        server.serverPort,
        "/webview/pane-1/zoom-out",
      );
      expect(JSON.parse(outRes.body).zoomLevel).toBe(0);
    });

    it("clamps zoom-in at 5 and zoom-out at -3", async () => {
      zoomLevel = 5;
      const inRes = await httpPost(
        server.serverPort,
        "/webview/pane-1/zoom-in",
      );
      expect(JSON.parse(inRes.body).zoomLevel).toBe(5);

      zoomLevel = -3;
      const outRes = await httpPost(
        server.serverPort,
        "/webview/pane-1/zoom-out",
      );
      expect(JSON.parse(outRes.body).zoomLevel).toBe(-3);
    });

    it("resets to 0", async () => {
      zoomLevel = 2;
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/zoom-reset",
      );
      expect(JSON.parse(res.body).zoomLevel).toBe(0);
    });
  });

  describe("POST /webview/:id/find and stop-find", () => {
    it("passes the query and its options to findInPage", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/find", {
        query: "needle",
        findNext: true,
      });
      expect(res.status).toBe(200);
      expect(mockWebContents.findInPage).toHaveBeenCalledWith("needle", {
        findNext: true,
      });
    });

    it("returns 400 for a missing query", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/find", {});
      expect(res.status).toBe(400);
      expect(mockWebContents.findInPage).not.toHaveBeenCalled();
    });

    it("clears the selection on stop-find", async () => {
      const res = await httpPost(
        server.serverPort,
        "/webview/pane-1/stop-find",
      );
      expect(res.status).toBe(200);
      expect(mockWebContents.stopFindInPage).toHaveBeenCalledWith(
        "clearSelection",
      );
    });
  });

  describe("POST /webview/:id/mute", () => {
    it("mutes on a boolean", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/mute", {
        muted: true,
      });
      expect(res.status).toBe(200);
      expect(mockWebContents.setAudioMuted).toHaveBeenCalledWith(true);
    });

    it("returns 400 without one", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/mute", {});
      expect(res.status).toBe(400);
      expect(mockWebContents.setAudioMuted).not.toHaveBeenCalled();
    });
  });

  describe("POST /webview/:id/stop", () => {
    it("stops the in-flight load", async () => {
      const res = await httpPost(server.serverPort, "/webview/pane-1/stop");
      expect(res.status).toBe(200);
      expect(mockWebContents.stop).toHaveBeenCalled();
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
