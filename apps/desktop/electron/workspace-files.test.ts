import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecShellBackend } from "./backend/exec-shell";
import { localExec } from "./backend/exec";
import { createRemoteExec, type RemoteExecClient } from "./backend/remote-exec";
import {
  contentHash,
  createWorkspaceFile,
  isSafeRelPath,
  listWorkspaceFiles,
  MAX_FILE_BYTES,
  readWorkspaceFile,
  writeWorkspaceFile,
  type FilesBackend,
} from "./workspace-files";

/**
 * A remote host's daemon, played by this machine: `exec` answers with an exit
 * code rather than rejecting, and files are written through `writeFile`, as
 * `TerminalHostClient` does over ssh.
 */
function daemonClient(): RemoteExecClient {
  return {
    exec: (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const code = (err as { code?: unknown } | null)?.code;
            resolve({ stdout, stderr, exitCode: err ? (typeof code === "number" ? code : null) : 0 });
          },
        );
      }),
    execStream: () => ({ cancel: () => {} }),
    readFile: (p) => readFile(p, "utf-8"),
    writeFile: async (p, data) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, data);
    },
  };
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf-8" });
}

const backends: Array<[string, () => FilesBackend]> = [
  ["local", () => ({ shell: new ExecShellBackend(localExec) })],
  ["remote (through the daemon's exec)", () => ({ shell: new ExecShellBackend(createRemoteExec(daemonClient())) })],
];

describe.each(backends)("workspace files on a %s host", (_name, makeBackend) => {
  let backend: FilesBackend;
  let tmp: string;
  let ws: string;

  beforeEach(async () => {
    backend = makeBackend();
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-files-")));
    ws = path.join(tmp, "ws");
    await mkdir(ws);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("list", () => {
    it("lists tracked and untracked files, leaving out what .gitignore names and what was deleted", async () => {
      git(ws, "init", "-q", "-b", "main");
      git(ws, "config", "user.email", "t@t.t");
      git(ws, "config", "user.name", "T");
      await writeFile(path.join(ws, ".gitignore"), "node_modules/\n*.log\n");
      await writeFile(path.join(ws, "tracked.ts"), "a\n");
      await writeFile(path.join(ws, "gone.ts"), "b\n");
      await mkdir(path.join(ws, "src/deep"), { recursive: true });
      await writeFile(path.join(ws, "src/deep/x y.ts"), "c\n");
      git(ws, "add", ".");
      git(ws, "commit", "-q", "-m", "init");
      await rm(path.join(ws, "gone.ts"));
      await writeFile(path.join(ws, "new.ts"), "d\n");
      await writeFile(path.join(ws, "debug.log"), "e\n");
      await mkdir(path.join(ws, "node_modules/pkg"), { recursive: true });
      await writeFile(path.join(ws, "node_modules/pkg/index.js"), "f\n");

      const result = await listWorkspaceFiles(backend, ws);

      expect(result).toEqual({
        paths: [".gitignore", "new.ts", "src/deep/x y.ts", "tracked.ts"],
        truncated: false,
        source: "git",
      });
    });

    it("walks a folder outside git, skipping dot-folders and node_modules", async () => {
      await mkdir(path.join(ws, "a"), { recursive: true });
      await writeFile(path.join(ws, "a/one.txt"), "1");
      await writeFile(path.join(ws, ".env"), "2");
      await mkdir(path.join(ws, ".cache"));
      await writeFile(path.join(ws, ".cache/x"), "3");
      await mkdir(path.join(ws, "node_modules"));
      await writeFile(path.join(ws, "node_modules/y"), "4");

      const result = await listWorkspaceFiles(backend, ws);

      expect(result).toEqual({ paths: [".env", "a/one.txt"], truncated: false, source: "walk" });
    });
  });

  describe("read", () => {
    it("answers the content and its hash", async () => {
      await writeFile(path.join(ws, "a.ts"), "const x = 1;\n");
      expect(await readWorkspaceFile(backend, ws, "a.ts")).toEqual({
        ok: true,
        content: "const x = 1;\n",
        hash: contentHash("const x = 1;\n"),
      });
    });

    it("reads an empty file", async () => {
      await writeFile(path.join(ws, "empty"), "");
      expect(await readWorkspaceFile(backend, ws, "empty")).toMatchObject({ ok: true, content: "" });
    });

    it("refuses a file over 2 MB, saying how large it is", async () => {
      await writeFile(path.join(ws, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
      expect(await readWorkspaceFile(backend, ws, "big.txt")).toMatchObject({
        ok: false,
        reason: "too-large",
        size: MAX_FILE_BYTES + 1,
      });
    });

    it("refuses a binary file", async () => {
      await writeFile(path.join(ws, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      expect(await readWorkspaceFile(backend, ws, "img.png")).toMatchObject({ ok: false, reason: "binary" });
    });

    it("refuses text that is not UTF-8, which saving would mangle", async () => {
      await writeFile(path.join(ws, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      expect(await readWorkspaceFile(backend, ws, "latin1.txt")).toMatchObject({ ok: false, reason: "binary" });
    });

    it("answers not-found and not-a-file", async () => {
      await mkdir(path.join(ws, "dir"));
      expect(await readWorkspaceFile(backend, ws, "nope.ts")).toMatchObject({ ok: false, reason: "not-found" });
      expect(await readWorkspaceFile(backend, ws, "dir")).toMatchObject({ ok: false, reason: "not-a-file" });
    });

    it("throws when the workspace folder is gone", async () => {
      await expect(readWorkspaceFile(backend, path.join(tmp, "missing"), "a.ts")).rejects.toThrow(
        /workspace folder does not exist/,
      );
    });
  });

  describe("paths outside the workspace", () => {
    beforeEach(async () => {
      await writeFile(path.join(tmp, "secret.txt"), "secret");
    });

    it.each(["../secret.txt", "a/../../secret.txt", "/etc/passwd", "", "./a.ts", "a//b"])(
      "refuses %j before running anything",
      async (rel) => {
        expect(await readWorkspaceFile(backend, ws, rel)).toMatchObject({ ok: false, reason: "outside-workspace" });
        expect(await writeWorkspaceFile(backend, ws, rel, "x")).toMatchObject({
          ok: false,
          reason: "outside-workspace",
        });
        expect(await createWorkspaceFile(backend, ws, rel)).toMatchObject({ ok: false, reason: "outside-workspace" });
      },
    );

    it("refuses a symlinked file that points out", async () => {
      await symlink(path.join(tmp, "secret.txt"), path.join(ws, "link.txt"));
      expect(await readWorkspaceFile(backend, ws, "link.txt")).toMatchObject({ ok: false, reason: "outside-workspace" });
      expect(await writeWorkspaceFile(backend, ws, "link.txt", "pwned")).toMatchObject({
        ok: false,
        reason: "outside-workspace",
      });
      expect(await readFile(path.join(tmp, "secret.txt"), "utf-8")).toBe("secret");
    });

    it("refuses a path through a symlinked folder that points out", async () => {
      await symlink(tmp, path.join(ws, "up"));
      expect(await readWorkspaceFile(backend, ws, "up/secret.txt")).toMatchObject({
        ok: false,
        reason: "outside-workspace",
      });
      expect(await createWorkspaceFile(backend, ws, "up/new.txt")).toMatchObject({
        ok: false,
        reason: "outside-workspace",
      });
    });

    it("follows a symlink that stays inside", async () => {
      await writeFile(path.join(ws, "real.txt"), "inside");
      await symlink(path.join(ws, "real.txt"), path.join(ws, "alias.txt"));
      expect(await readWorkspaceFile(backend, ws, "alias.txt")).toMatchObject({ ok: true, content: "inside" });
    });
  });

  describe("write", () => {
    it("writes the file, creating its folders, and answers the new hash", async () => {
      const result = await writeWorkspaceFile(backend, ws, "src/new/a.ts", "hello\n");
      expect(result).toEqual({ ok: true, hash: contentHash("hello\n") });
      expect(await readFile(path.join(ws, "src/new/a.ts"), "utf-8")).toBe("hello\n");
    });

    it("writes over a file that still has the expected hash", async () => {
      await writeFile(path.join(ws, "a.ts"), "v1");
      const result = await writeWorkspaceFile(backend, ws, "a.ts", "v2", contentHash("v1"));
      expect(result).toEqual({ ok: true, hash: contentHash("v2") });
      expect(await readFile(path.join(ws, "a.ts"), "utf-8")).toBe("v2");
    });

    it("leaves a file that changed on disk alone, answering its hash now", async () => {
      await writeFile(path.join(ws, "a.ts"), "theirs");
      const result = await writeWorkspaceFile(backend, ws, "a.ts", "mine", contentHash("v1"));
      expect(result).toMatchObject({ ok: false, reason: "changed-on-disk", diskHash: contentHash("theirs") });
      expect(await readFile(path.join(ws, "a.ts"), "utf-8")).toBe("theirs");
    });

    it("calls a file deleted on disk changed, with no hash", async () => {
      const result = await writeWorkspaceFile(backend, ws, "gone.ts", "mine", contentHash("v1"));
      expect(result).toMatchObject({ ok: false, reason: "changed-on-disk", diskHash: null });
    });

    it("refuses to write over a folder", async () => {
      await mkdir(path.join(ws, "dir"));
      expect(await writeWorkspaceFile(backend, ws, "dir", "x")).toMatchObject({ ok: false, reason: "not-a-file" });
    });
  });

  describe("create", () => {
    it("creates an empty file and its folders", async () => {
      expect(await createWorkspaceFile(backend, ws, "a/b/new.ts")).toEqual({ ok: true, hash: contentHash("") });
      expect(await readFile(path.join(ws, "a/b/new.ts"), "utf-8")).toBe("");
    });

    it("refuses a path that already exists, leaving it as it was", async () => {
      await writeFile(path.join(ws, "a.ts"), "keep");
      expect(await createWorkspaceFile(backend, ws, "a.ts")).toMatchObject({ ok: false, reason: "exists" });
      expect(await readFile(path.join(ws, "a.ts"), "utf-8")).toBe("keep");
    });
  });
});

describe("isSafeRelPath", () => {
  it("accepts plain relative paths and refuses the rest", () => {
    expect(isSafeRelPath("a.ts")).toBe(true);
    expect(isSafeRelPath("src/.hidden/a.ts")).toBe(true);
    expect(isSafeRelPath("a..b")).toBe(true);
    for (const bad of ["", "/a", "C:/a", "a/../b", "..", ".", "a/./b", "a\\b", "a\0b", "a/"]) {
      expect(isSafeRelPath(bad)).toBe(false);
    }
  });
});
