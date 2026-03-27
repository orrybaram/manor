import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
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
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn(),
  },
}));

import { WebviewServer } from "../webview-server";
import { webContents } from "electron";

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
    (mockWebContents.loadURL as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    server = new WebviewServer(registry);
    await server.start();
  });

  afterEach(() => {
    server.stop();
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
