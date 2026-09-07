import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commandTable,
  parseArgs,
  runCli,
  toCommandName,
  toFlagName,
  type CliIo,
} from "./cli";
import { modules } from "./modules";
import type { Http } from "./types";
import { HttpError } from "./types";

// ── Harness ──

function fakeHttp(impl: Partial<Http> = {}) {
  return {
    get: vi.fn(impl.get ?? (async () => ({}))),
    post: vi.fn(impl.post ?? (async () => ({}))),
    del: vi.fn(impl.del ?? (async () => ({}))),
  };
}

function captureIo(stdinText?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    ...(stdinText !== undefined ? { stdin: { read: () => stdinText } } : {}),
  };
  return {
    io,
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
  };
}

const allTools = modules.flatMap((m) => m.tools);

function propsOf(toolName: string): Record<string, { type?: string }> {
  const tool = allTools.find((t) => t.name === toolName)!;
  return (tool.inputSchema.properties ?? {}) as Record<
    string,
    { type?: string }
  >;
}

function toolFor(command: string) {
  return commandTable().get(command)!;
}

const writtenFiles: string[] = [];
afterEach(() => {
  for (const file of writtenFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

// ── Name derivation ──

/** The inverse of `toFlagName`, so the round trip is checked both ways. */
function toPropName(flag: string): string {
  return flag.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

describe("name derivation", () => {
  it("round trips every tool name in every module", () => {
    for (const tool of allTools) {
      const command = toCommandName(tool.name);
      expect(command).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(command.replace(/-/g, "_")).toBe(tool.name);
      expect(commandTable().get(command)).toBe(tool);
    }
  });

  it("round trips every schema property in every module", () => {
    for (const tool of allTools) {
      for (const prop of Object.keys(propsOf(tool.name))) {
        const flag = toFlagName(prop);
        expect(flag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(toPropName(flag)).toBe(prop);
      }
    }
  });

  it("generates one command per tool, with no duplicates", () => {
    expect(commandTable().size).toBe(allTools.length);
  });
});

// ── Help ──

/** `  <command>  <summary>` lines from the global help, in order. */
function helpEntries(
  help: string,
): Array<{ command: string; summary: string }> {
  return help
    .split("\n")
    .map((line) => /^ {2}(\S+) {2,}(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ command: m[1], summary: m[2] }));
}

describe("help", () => {
  it("lists every command exactly once, plus the api escape hatch", async () => {
    const io = captureIo();
    expect(await runCli(["--help"], fakeHttp(), io.io)).toBe(0);

    const listed = helpEntries(io.stdout).map((e) => e.command);
    expect(listed.slice().sort()).toEqual(
      [...commandTable().keys(), "api"].sort(),
    );
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("shows only the first sentence of each description", async () => {
    const io = captureIo();
    await runCli([], fakeHttp(), io.io);

    for (const { summary } of helpEntries(io.stdout)) {
      expect(summary).not.toContain(". ");
    }
    // The long descriptions really are truncated, not merely period-free.
    const full = toolFor("list-panes").description;
    expect(io.stdout).not.toContain(full);
    expect(io.stdout).toContain(full.slice(0, 40));
  });

  it("groups commands under their module label", async () => {
    const io = captureIo();
    await runCli(["--help"], fakeHttp(), io.io);
    for (const label of [
      "webview:",
      "projects:",
      "agents:",
      "panes:",
      "sessions:",
    ]) {
      expect(io.stdout).toContain(label);
    }
  });

  it("prints the full description and a flag block for one command", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(await runCli(["remove-workspace", "--help"], http, io.io)).toBe(0);

    expect(io.stdout).toContain(toolFor("remove-workspace").description);
    expect(io.stdout).toContain("Flags:");
    expect(io.stdout).toMatch(/--project-id <string>\s+Project ID\./);
    expect(io.stdout).toMatch(/--worktree-path <string>.*\(required\)/);
    expect(io.stdout).toMatch(/--delete-branch <boolean>/);
    expect(io.stdout).not.toMatch(/--delete-branch <boolean>.*\(required\)/);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("accepts -h after the command name", async () => {
    const io = captureIo();
    expect(await runCli(["get-project", "-h"], fakeHttp(), io.io)).toBe(0);
    expect(io.stdout).toContain("Usage: manor get-project");
  });

  it("renders an enum flag as --flag <a|b|c> instead of <string>", async () => {
    const io = captureIo();
    expect(await runCli(["split-pane", "--help"], fakeHttp(), io.io)).toBe(0);
    expect(io.stdout).toContain("--direction <horizontal|vertical>");
  });

  it("mentions the stdin/file flag convention under Usage", async () => {
    const io = captureIo();
    await runCli(["--help"], fakeHttp(), io.io);
    expect(io.stdout).toContain(
      "Flag values: - reads stdin, @file reads a file.",
    );
  });

  it("rejects an unknown command with exit 2", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(await runCli(["frobnicate"], http, io.io)).toBe(2);
    expect(io.stderr).toBe("Unknown command: frobnicate. Run manor --help.\n");
    expect(http.get).not.toHaveBeenCalled();
  });
});

// ── Dispatch ──

const PROJECT = {
  id: "abc",
  name: "Manor",
  path: "/code/manor",
  defaultBranch: "main",
  workspaces: [],
};

describe("dispatch", () => {
  it("maps --project-id onto the tool's projectId and prints the handler's text", async () => {
    const io = captureIo();
    const http = fakeHttp({ get: async () => PROJECT });
    expect(
      await runCli(["get-project", "--project-id", "abc"], http, io.io),
    ).toBe(0);

    expect(http.get).toHaveBeenCalledWith("/projects/abc");
    expect(io.stdout).toBe(
      "abc: Manor\n  path: /code/manor\n  default branch: main\n  workspaces (0):\n",
    );
    expect(io.stderr).toBe("");
  });

  it("accepts the camelCase --projectId form too", async () => {
    const io = captureIo();
    const http = fakeHttp({ get: async () => PROJECT });
    expect(
      await runCli(["get-project", "--projectId", "abc"], http, io.io),
    ).toBe(0);
    expect(http.get).toHaveBeenCalledWith("/projects/abc");
  });

  it("accepts --flag=value", async () => {
    const io = captureIo();
    const http = fakeHttp({ get: async () => PROJECT });
    expect(await runCli(["get-project", "--project-id=abc"], http, io.io)).toBe(
      0,
    );
    expect(http.get).toHaveBeenCalledWith("/projects/abc");
  });

  it("coerces number flags before calling the handler", async () => {
    const io = captureIo();
    const http = fakeHttp({
      post: async () => ({
        target: { kind: "agent", id: "a1" },
        source: "buffer",
        lineCount: 2,
        truncated: false,
        text: "hello",
      }),
    });
    expect(
      await runCli(
        ["read-session", "--target", "a1", "--tail-lines", "50"],
        http,
        io.io,
      ),
    ).toBe(0);
    expect(http.post).toHaveBeenCalledWith(
      "/sessions/read",
      expect.objectContaining({ target: "a1", tailLines: 50 }),
    );
    expect(io.stdout).toContain("hello");
  });

  it("rejects a non-numeric number flag with exit 2, naming the flag", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(
      await runCli(
        ["read-session", "--target", "a1", "--tail-lines", "soon"],
        http,
        io.io,
      ),
    ).toBe(2);
    expect(io.stderr).toContain("--tail-lines");
    expect(io.stderr).toContain("number");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("sends false for the --no- form of a boolean flag", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(
      await runCli(
        [
          "remove-workspace",
          "--project-id",
          "abc",
          "--worktree-path",
          "/ws",
          "--no-delete-branch",
        ],
        http,
        io.io,
      ),
    ).toBe(0);
    expect(http.del).toHaveBeenCalledWith("/projects/abc/workspaces", {
      worktreePath: "/ws",
      deleteBranch: false,
    });
  });

  it("sends true for the bare form of a boolean flag", async () => {
    const io = captureIo();
    const http = fakeHttp();
    await runCli(
      [
        "remove-workspace",
        "--project-id",
        "abc",
        "--worktree-path",
        "/ws",
        "--delete-branch",
      ],
      http,
      io.io,
    );
    expect(http.del).toHaveBeenCalledWith("/projects/abc/workspaces", {
      worktreePath: "/ws",
      deleteBranch: true,
    });
  });

  it("lists every missing required flag in one usage error and never calls http", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(await runCli(["add-project"], http, io.io)).toBe(2);
    expect(io.stderr).toContain("--name");
    expect(io.stderr).toContain("--path");
    expect(io.stdout).toBe("");
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it("rejects an unknown flag with exit 2 and lists the valid ones", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(await runCli(["get-project", "--nope", "x"], http, io.io)).toBe(2);
    expect(io.stderr).toContain("Unknown flag --nope");
    expect(io.stderr).toContain("--project-id");
    expect(http.get).not.toHaveBeenCalled();
  });

  it("rejects an enum flag value outside the schema's list, naming the allowed values", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(
      await runCli(["split-pane", "--direction", "diagonal"], http, io.io),
    ).toBe(2);
    expect(io.stderr).toContain("horizontal, vertical");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("passes a valid enum flag value through to the handler", async () => {
    const io = captureIo();
    const http = fakeHttp({ post: async () => ({ paneId: "p2" }) });
    expect(
      await runCli(["split-pane", "--direction", "vertical"], http, io.io),
    ).toBe(0);
    expect(http.post).toHaveBeenCalledWith(
      "/panes/split",
      expect.objectContaining({ direction: "vertical" }),
    );
  });

  it("writes image content to a png under tmpdir and prints only the path", async () => {
    const png = Buffer.from("not-really-a-png");
    const io = captureIo();
    const http = fakeHttp({
      post: async () => ({ image: png.toString("base64") }),
    });
    expect(
      await runCli(["screenshot-webview", "--pane-id", "p1"], http, io.io),
    ).toBe(0);

    expect(http.post).toHaveBeenCalledWith("/webview/p1/screenshot");
    const match = /^Saved (.+\.png)\n$/.exec(io.stdout);
    expect(match).not.toBeNull();
    const file = match![1];
    writtenFiles.push(file);
    expect(file.startsWith(os.tmpdir())).toBe(true);
    expect(file).toContain("manor-screenshot-webview-");
    expect(fs.readFileSync(file)).toEqual(png);
    expect(io.stdout).not.toContain(png.toString("base64"));
  });

  it("reports a dead control server with exit 1", async () => {
    const io = captureIo();
    const connErr = new TypeError("fetch failed");
    (connErr as { cause?: unknown }).cause = new Error("ECONNREFUSED");
    const http = fakeHttp({
      get: async () => {
        throw connErr;
      },
    });
    expect(await runCli(["list-projects"], http, io.io)).toBe(1);
    expect(io.stderr).toBe("Cannot connect to Manor — is it running?\n");
    expect(io.stdout).toBe("");
  });

  it("reports any other handler failure with its message and exit 1", async () => {
    const io = captureIo();
    const http = fakeHttp({
      get: async () => {
        throw new Error("No webviews are currently open in Manor.");
      },
    });
    expect(await runCli(["screenshot-webview"], http, io.io)).toBe(1);
    expect(io.stderr).toBe("No webviews are currently open in Manor.\n");
  });
});

// ── stdin and file flag values ──

describe("stdin and file flag values", () => {
  it("reads a flag value from stdin when given -", async () => {
    const io = captureIo("console.log(1)");
    const http = fakeHttp({ post: async () => ({ result: null }) });
    expect(
      await runCli(
        ["execute-js", "--pane-id", "p1", "--code", "-"],
        http,
        io.io,
      ),
    ).toBe(0);
    expect(http.post).toHaveBeenCalledWith("/webview/p1/execute-js", {
      code: "console.log(1)",
    });
  });

  it("rejects - with exit 2 when no stdin reader is available", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(
      await runCli(
        ["execute-js", "--pane-id", "p1", "--code", "-"],
        http,
        io.io,
      ),
    ).toBe(2);
    expect(io.stderr).toContain("--code");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("reads a flag value from a file with @path", async () => {
    const file = path.join(
      os.tmpdir(),
      `manor-cli-stdin-test-${Date.now()}.js`,
    );
    fs.writeFileSync(file, "console.log(2)");
    writtenFiles.push(file);

    const io = captureIo();
    const http = fakeHttp({ post: async () => ({ result: null }) });
    expect(
      await runCli(
        ["execute-js", "--pane-id", "p1", "--code", `@${file}`],
        http,
        io.io,
      ),
    ).toBe(0);
    expect(http.post).toHaveBeenCalledWith("/webview/p1/execute-js", {
      code: "console.log(2)",
    });
  });

  it("rejects @<missing file> with exit 2", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(
      await runCli(
        ["execute-js", "--pane-id", "p1", "--code", "@/no/such/file"],
        http,
        io.io,
      ),
    ).toBe(2);
    expect(io.stderr).toContain("--code");
    expect(http.post).not.toHaveBeenCalled();
  });
});

// ── Parser units the generated surface has no tool for yet ──

describe("parseArgs", () => {
  it("repeats array flags and coerces numeric items", () => {
    const tool = toolFor("batch-create-workspaces");
    expect(
      parseArgs("batch-create-workspaces", tool, [
        "--issues",
        "1",
        "--issues",
        "2",
      ]),
    ).toEqual({ issues: [1, 2] });
  });

  it("rejects a non-numeric array item", () => {
    const tool = toolFor("batch-create-workspaces");
    expect(() =>
      parseArgs("batch-create-workspaces", tool, ["--issues", "one"]),
    ).toThrow(/--issues/);
  });

  it("parses object flags as JSON and rejects malformed JSON", () => {
    const tool = {
      name: "fake_tool",
      description: "Fake.",
      inputSchema: {
        type: "object",
        properties: { payload: { type: "object" } },
      },
    };
    expect(parseArgs("fake-tool", tool, ["--payload", '{"a":1}'])).toEqual({
      payload: { a: 1 },
    });
    expect(() => parseArgs("fake-tool", tool, ["--payload", "{a"])).toThrow(
      /--payload expects JSON/,
    );
  });

  it("takes a value starting with a dash", () => {
    const tool = toolFor("list-agents");
    expect(parseArgs("list-agents", tool, ["--limit", "-1"])).toEqual({
      limit: -1,
    });
  });
});

// ── api escape hatch ──

describe("api", () => {
  it("posts a parsed --body and prints pretty JSON", async () => {
    const io = captureIo();
    const http = fakeHttp({ post: async () => ({ id: "p1", path: "/x" }) });
    expect(
      await runCli(
        ["api", "POST", "/projects", "--body", '{"path":"/x"}'],
        http,
        io.io,
      ),
    ).toBe(0);
    expect(http.post).toHaveBeenCalledWith("/projects", { path: "/x" });
    expect(io.stdout).toBe(
      `${JSON.stringify({ id: "p1", path: "/x" }, null, 2)}\n`,
    );
  });

  it("gets a path with no body", async () => {
    const io = captureIo();
    const http = fakeHttp({ get: async () => [{ id: "p1" }] });
    expect(await runCli(["api", "get", "/projects"], http, io.io)).toBe(0);
    expect(http.get).toHaveBeenCalledWith("/projects");
  });

  it("deletes with a body", async () => {
    const io = captureIo();
    const http = fakeHttp({ del: async () => ({ ok: true }) });
    expect(
      await runCli(
        [
          "api",
          "DELETE",
          "/projects/p1/workspaces",
          '--body={"worktreePath":"/ws"}',
        ],
        http,
        io.io,
      ),
    ).toBe(0);
    expect(http.del).toHaveBeenCalledWith("/projects/p1/workspaces", {
      worktreePath: "/ws",
    });
  });

  it("rejects a malformed --body with exit 2", async () => {
    const io = captureIo();
    const http = fakeHttp();
    expect(
      await runCli(
        ["api", "POST", "/projects", "--body", "{oops"],
        http,
        io.io,
      ),
    ).toBe(2);
    expect(io.stderr).toContain("--body expects JSON");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("rejects an unknown method and a missing path with exit 2", async () => {
    const io = captureIo();
    expect(await runCli(["api", "PATCH", "/projects"], fakeHttp(), io.io)).toBe(
      2,
    );
    expect(await runCli(["api", "GET"], fakeHttp(), io.io)).toBe(2);
    expect(io.stderr).toContain("PATCH");
  });

  it("prints HTTP <status>: <rawBody> and exits 1 on an HttpError", async () => {
    const io = captureIo();
    const http = fakeHttp({
      get: async () => {
        throw new HttpError(404, { error: "nope" }, '{"error":"nope"}');
      },
    });
    expect(await runCli(["api", "GET", "/projects/x"], http, io.io)).toBe(1);
    expect(io.stderr).toBe('HTTP 404: {"error":"nope"}\n');
  });
});
