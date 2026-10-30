import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs — http-client.ts only ever calls readFileSync/existsSync on
// port files, never writes.
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// Mock fetch globally.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function fetchOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function fetchErr(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

/** The connection-level TypeError fetch throws when nothing is listening. */
function connectionRefused(): TypeError {
  const err = new TypeError("fetch failed");
  (err as NodeJS.ErrnoException).cause = Object.assign(
    new Error("connect ECONNREFUSED"),
    { code: "ECONNREFUSED" },
  );
  return err;
}

describe("http-client", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.MANOR_CONTROL_PORT_FILE;
    delete process.env.MANOR_WEBVIEW_PORT;
    delete process.env.MANOR_WEBVIEW_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ── Local path (no MANOR_CONTROL_PORT_FILE): unchanged ──

  describe("without MANOR_CONTROL_PORT_FILE", () => {
    /** Serve Manor desktop's port and token files; null leaves one missing. */
    function localFiles(port: string | null, token: string | null) {
      mockExistsSync.mockImplementation((file: string) =>
        file.endsWith("webview-server-port") ? port !== null : false,
      );
      mockReadFileSync.mockImplementation((file: string) => {
        if (file.endsWith("webview-server-port") && port !== null) return `${port}\n`;
        if (file.endsWith("webview-server-token") && token !== null) return `${token}\n`;
        throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      });
    }

    function sentToken(call: number): string | undefined {
      const [, init] = mockFetch.mock.calls[call];
      return (init?.headers as Record<string, string>)["x-manor-control-token"];
    }

    it("reads the webview port and token files and sends the token", async () => {
      localFiles("4321", "file-token");
      mockFetch.mockResolvedValue(fetchOk({ ok: true }));

      const { createHttp } = await import("./http-client");
      const http = createHttp();
      const result = await http.get("/projects");

      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe("http://127.0.0.1:4321/projects");
      expect(sentToken(0)).toBe("file-token");
    });

    it("pairs the env port with the env token", async () => {
      process.env.MANOR_WEBVIEW_PORT = "1111";
      process.env.MANOR_WEBVIEW_TOKEN = "env-token";
      localFiles(null, null);
      mockFetch.mockResolvedValue(fetchOk({ ok: true }));

      const { createHttp } = await import("./http-client");
      await createHttp().get("/projects");

      expect(mockFetch.mock.calls[0][0]).toBe("http://127.0.0.1:1111/projects");
      expect(sentToken(0)).toBe("env-token");
    });

    it("prefers the file's token when env and file name the same port", async () => {
      process.env.MANOR_WEBVIEW_PORT = "4321";
      process.env.MANOR_WEBVIEW_TOKEN = "stale-env-token";
      localFiles("4321", "file-token");
      mockFetch.mockResolvedValue(fetchOk({ ok: true }));

      const { createHttp } = await import("./http-client");
      await createHttp().get("/projects");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentToken(0)).toBe("file-token");
    });

    it("falls through to the files when the env pairing is refused", async () => {
      process.env.MANOR_WEBVIEW_PORT = "1111";
      process.env.MANOR_WEBVIEW_TOKEN = "stale-env-token";
      localFiles("4321", "file-token");
      mockFetch
        .mockResolvedValueOnce(fetchErr(401, { error: "Missing or wrong token" }))
        .mockResolvedValueOnce(fetchOk({ ok: true }));

      const { createHttp } = await import("./http-client");
      const result = await createHttp().get("/projects");

      expect(result).toEqual({ ok: true });
      expect(mockFetch.mock.calls[1][0]).toBe("http://127.0.0.1:4321/projects");
      expect(sentToken(1)).toBe("file-token");
    });

    it("explains a refused token when no candidate is accepted", async () => {
      localFiles("4321", "file-token");
      mockFetch.mockResolvedValue(fetchErr(401, { error: "Missing or wrong token" }));

      const { createHttp } = await import("./http-client");
      await expect(createHttp().get("/projects")).rejects.toThrow(
        "Manor refused this terminal's control token",
      );
    });

    it("declares a JSON body on every POST and DELETE, even an empty one", async () => {
      localFiles("4321", "file-token");
      mockFetch.mockResolvedValue(fetchOk({ ok: true }));

      const { createHttp } = await import("./http-client");
      const http = createHttp();
      await http.post("/tabs");
      await http.del("/panes/p1");

      for (const call of [0, 1]) {
        const [, init] = mockFetch.mock.calls[call];
        expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      }
    });

    it("surfaces HttpError for a non-2xx response", async () => {
      localFiles("4321", "file-token");
      mockFetch.mockResolvedValue(fetchErr(404, { error: "not found" }));

      const { createHttp } = await import("./http-client");
      const http = createHttp();
      await expect(http.get("/projects/xyz")).rejects.toMatchObject({
        name: "HttpError",
        status: 404,
      });
    });
  });

  // ── Remote control relay path ──

  describe("with MANOR_CONTROL_PORT_FILE", () => {
    beforeEach(() => {
      process.env.MANOR_CONTROL_PORT_FILE = "/home/user/.manor/remote/control-port";
    });

    it("reads the port file on each request and sends the token header", async () => {
      mockReadFileSync.mockReturnValue("9999\nsecret-token\n");
      mockFetch.mockResolvedValue(fetchOk({ projects: [] }));

      const { createHttp } = await import("./http-client");
      const http = createHttp();
      const result = await http.get("/projects");

      expect(result).toEqual({ projects: [] });
      expect(mockReadFileSync).toHaveBeenCalledWith(
        "/home/user/.manor/remote/control-port",
        "utf-8",
      );
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9999/projects");
      expect((init.headers as Record<string, string>)["x-manor-control-token"]).toBe(
        "secret-token",
      );

      // Re-read on a second call, not cached.
      mockReadFileSync.mockReturnValue("8888\nother-token\n");
      await http.get("/projects");
      expect(mockReadFileSync).toHaveBeenCalledTimes(2);
      const [url2, init2] = mockFetch.mock.calls[1];
      expect(url2).toBe("http://127.0.0.1:8888/projects");
      expect((init2.headers as Record<string, string>)["x-manor-control-token"]).toBe(
        "other-token",
      );
    });

    it("never falls back to MANOR_WEBVIEW_PORT or the webview port file", async () => {
      process.env.MANOR_WEBVIEW_PORT = "1111";
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((file: string) => {
        if (file === "/home/user/.manor/remote/control-port") {
          return "9999\nsecret-token\n";
        }
        throw new Error(`unexpected read of ${file}`);
      });
      mockFetch.mockResolvedValue(fetchOk({ ok: true }));

      const { createHttp } = await import("./http-client");
      const http = createHttp();
      await http.get("/projects");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:9999/projects");
      // The webview port file / env must never be consulted.
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it("throws the unreachable message when the port file is missing", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const { createHttp } = await import("./http-client");
      const http = createHttp();

      await expect(http.get("/projects")).rejects.toThrow(
        "Manor's remote daemon isn't reachable. Reconnect the host in Manor",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws the unreachable message when the port file is malformed", async () => {
      mockReadFileSync.mockReturnValue("not-a-port\n");

      const { createHttp } = await import("./http-client");
      const http = createHttp();

      await expect(http.get("/projects")).rejects.toThrow(
        "Manor's remote daemon isn't reachable. Reconnect the host in Manor",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws the unreachable message when the connection is refused", async () => {
      mockReadFileSync.mockReturnValue("9999\nsecret-token\n");
      mockFetch.mockRejectedValue(connectionRefused());

      const { createHttp } = await import("./http-client");
      const http = createHttp();

      await expect(http.get("/projects")).rejects.toThrow(
        "Manor's remote daemon isn't reachable. Reconnect the host in Manor",
      );
    });

    it("keeps a non-2xx response on the HttpError path so body.error is preserved", async () => {
      mockReadFileSync.mockReturnValue("9999\nsecret-token\n");
      mockFetch.mockResolvedValue(
        fetchErr(503, { error: "Manor desktop is not connected to this host" }),
      );

      const { createHttp } = await import("./http-client");
      const http = createHttp();

      await expect(http.get("/projects")).rejects.toMatchObject({
        name: "HttpError",
        status: 503,
        body: { error: "Manor desktop is not connected to this host" },
      });
    });

    it("keeps a 403 response on the HttpError path", async () => {
      mockReadFileSync.mockReturnValue("9999\nsecret-token\n");
      mockFetch.mockResolvedValue(
        fetchErr(403, { error: "GET /panes isn't available from remote hosts" }),
      );

      const { createHttp } = await import("./http-client");
      const http = createHttp();

      await expect(http.get("/panes")).rejects.toMatchObject({
        name: "HttpError",
        status: 403,
        body: { error: "GET /panes isn't available from remote hosts" },
      });
    });
  });
});
