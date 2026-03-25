import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests for the MCP webview server logic.
 *
 * The MCP server (mcp-webview-server.ts) is a standalone script that calls
 * readPort() at module-load time and exits if the port file is missing.
 * Since we can't easily test the full module lifecycle, we test the core
 * behaviours indirectly: port file reading, fetch-based HTTP calls, and
 * pane resolution logic — by replicating the key functions and testing
 * them against a real WebviewServer instance.
 */

// ── Mock electron for the WebviewServer import ──

const mockWebContents: Record<string, unknown> = {
  getURL: vi.fn(() => "https://example.com"),
  getTitle: vi.fn(() => "Test Page"),
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

// ── Replicate MCP server helper functions for testing ──

interface WebviewInfo {
  paneId: string;
  url: string;
  title: string;
}

async function mcpHttpGet(baseUrl: string, urlPath: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function mcpHttpPost(
  baseUrl: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function resolvePaneId(
  baseUrl: string,
  paneId: string | undefined,
): Promise<string> {
  if (paneId) return paneId;

  const webviews = (await mcpHttpGet(baseUrl, "/webviews")) as WebviewInfo[];
  if (webviews.length === 0) {
    throw new Error("No webviews are currently open in Manor.");
  }
  if (webviews.length === 1) {
    return webviews[0].paneId;
  }
  const listing = webviews
    .map((w) => `  - ${w.paneId}: ${w.title} (${w.url})`)
    .join("\n");
  throw new Error(`Multiple webviews open. Specify a paneId:\n${listing}`);
}

// ── Tests ──

describe("MCP webview server logic", () => {
  let server: WebviewServer;
  let registry: Map<string, number>;
  let baseUrl: string;

  beforeEach(async () => {
    registry = new Map<string, number>();

    (webContents.fromId as ReturnType<typeof vi.fn>).mockImplementation(
      (id: number) => {
        if (id === 101 || id === 102) return mockWebContents;
        return null;
      },
    );

    // Reset mocks
    for (const key of Object.keys(mockWebContents)) {
      const fn = mockWebContents[key] as ReturnType<typeof vi.fn>;
      fn.mockClear();
    }
    (mockWebContents.getURL as ReturnType<typeof vi.fn>).mockReturnValue(
      "https://example.com",
    );
    (mockWebContents.getTitle as ReturnType<typeof vi.fn>).mockReturnValue(
      "Test Page",
    );
    (mockWebContents.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    (
      mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
    ).mockResolvedValue("result");
    (mockWebContents.loadURL as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    server = new WebviewServer(registry);
    await server.start();
    baseUrl = `http://127.0.0.1:${server.serverPort}`;
  });

  afterEach(() => {
    server.stop();
  });

  describe("port file reading", () => {
    it("port file contains valid port number", () => {
      const portFile = path.join(
        process.env.HOME || "/tmp",
        ".manor",
        "webview-server-port",
      );
      const content = fs.readFileSync(portFile, "utf-8").trim();
      const port = parseInt(content, 10);
      expect(port).toBe(server.serverPort);
      expect(port).toBeGreaterThan(0);
      expect(isNaN(port)).toBe(false);
    });

    it("port file is removed on stop", () => {
      const portFile = path.join(
        process.env.HOME || "/tmp",
        ".manor",
        "webview-server-port",
      );
      server.stop();
      expect(fs.existsSync(portFile)).toBe(false);
    });
  });

  describe("fetch-based HTTP calls", () => {
    it("when server is not running, fetch fails with connection error", async () => {
      server.stop();
      // Use a port that's definitely not listening
      await expect(
        mcpHttpGet("http://127.0.0.1:1", "/webviews"),
      ).rejects.toThrow();
    });

    it("tools return error for non-200 responses", async () => {
      // Unknown pane → 404
      await expect(
        mcpHttpPost(baseUrl, "/webview/nonexistent/screenshot"),
      ).rejects.toThrow("HTTP 404");
    });
  });

  describe("paneId auto-resolution", () => {
    it("returns the paneId when explicitly provided", async () => {
      const result = await resolvePaneId(baseUrl, "explicit-id");
      expect(result).toBe("explicit-id");
    });

    it("when one webview exists, uses it automatically", async () => {
      registry.set("only-pane", 101);
      const result = await resolvePaneId(baseUrl, undefined);
      expect(result).toBe("only-pane");
    });

    it("when multiple webviews exist, returns error listing them", async () => {
      registry.set("pane-a", 101);
      registry.set("pane-b", 102);
      await expect(resolvePaneId(baseUrl, undefined)).rejects.toThrow(
        "Multiple webviews open",
      );
    });

    it("when no webviews exist, returns descriptive error", async () => {
      // registry is empty by default
      await expect(resolvePaneId(baseUrl, undefined)).rejects.toThrow(
        "No webviews are currently open",
      );
    });
  });

  describe("tool response formatting", () => {
    it("list_webviews returns webview listing via HTTP", async () => {
      registry.set("pane-1", 101);
      const webviews = (await mcpHttpGet(
        baseUrl,
        "/webviews",
      )) as WebviewInfo[];
      expect(webviews).toHaveLength(1);
      expect(webviews[0].paneId).toBe("pane-1");
      expect(webviews[0].url).toBe("https://example.com");
      expect(webviews[0].title).toBe("Test Page");
    });

    it("get_url returns URL string via HTTP", async () => {
      registry.set("pane-1", 101);
      const result = (await mcpHttpGet(baseUrl, "/webview/pane-1/url")) as {
        url: string;
      };
      expect(result.url).toBe("https://example.com");
    });

    it("execute_js returns result via HTTP", async () => {
      registry.set("pane-1", 101);
      (
        mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        answer: 42,
      });
      const result = (await mcpHttpPost(baseUrl, "/webview/pane-1/execute-js", {
        code: "({answer: 42})",
      })) as { result: unknown };
      expect(result.result).toEqual({ answer: 42 });
    });

    it("navigate calls loadURL and returns success", async () => {
      registry.set("pane-1", 101);
      const result = (await mcpHttpPost(baseUrl, "/webview/pane-1/navigate", {
        url: "https://new-url.com",
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith(
        "https://new-url.com",
      );
    });
  });
});
