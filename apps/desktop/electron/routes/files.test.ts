/**
 * `POST /files/open`, through the server routes as a host's CLI reaches it,
 * over real files: a new tab, the tab already showing it, the refusals, and a
 * workspace on an adopted host sent to its server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { isRemoteAllowed } from "../host-server/cli-relay";
import { handleServerControlRequest } from "./server-routes";
import type { ServerRouteDeps } from "./types";
import type { WorkspaceLayout } from "../../src/lib/layout/workspace-layout";

const run = promisify(execFile);
const backend = {
  shell: {
    exec: async (cmd: string, args: string[]) => (await run(cmd, args)).stdout,
    writeFile: vi.fn(),
  },
};

function layoutWith(tabs: unknown[]): { layout: WorkspaceLayout } {
  return {
    layout: { panels: { p1: { id: "p1", tabs, pinnedTabIds: [] } } } as unknown as WorkspaceLayout,
  };
}

describe("POST /files/open", () => {
  let tmp: string;
  let workspace: string;
  let outside: string;
  let entry: { layout: WorkspaceLayout } | null;
  let apply: ReturnType<typeof vi.fn>;
  let showFile: ReturnType<typeof vi.fn>;
  let control: ReturnType<typeof vi.fn>;
  let lastActive: string | null;
  let deps: ServerRouteDeps;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "manor-files-route-")));
    workspace = path.join(tmp, "ws");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export {};\n");
    outside = path.join(tmp, "notes.md");
    fs.writeFileSync(outside, "# notes\n");
    entry = layoutWith([]);
    apply = vi.fn(async () => ({ version: 1, addedPaneIds: [] }));
    showFile = vi.fn();
    control = vi.fn(async () => ({ status: 200, body: { paneId: "remote" } }));
    lastActive = null;
    deps = {
      backendRegistry: { get: () => backend },
      layoutStore: {
        get: () => entry,
        apply,
        getLastActiveWorkspacePath: () => lastActive,
        primaryViewport: () => null,
      },
      projectManager: {
        hostIdForPath: (p: string) => (p === "/on-box" ? "box" : undefined),
        decorateRemoteResult: (x: unknown) => x,
      },
      hostRouting: {
        proxy: (hostId: string) => (hostId === "box" ? {} : null),
        control,
      },
      showFile,
    } as unknown as ServerRouteDeps;
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function post(body: Record<string, unknown>) {
    let answer: { status: number; body: Record<string, unknown> } | undefined;
    await handleServerControlRequest(
      deps,
      "POST",
      new URL("http://x/files/open"),
      (status, b) => {
        answer = { status, body: b as Record<string, unknown> };
      },
      async () => body,
    );
    return answer!;
  }

  const openedTab = () => apply.mock.calls[0][1].tab;

  it("is what a remote host's CLI may call", () => {
    expect(isRemoteAllowed("POST", "/files/open")).toBe(true);
  });

  it("opens a file outside the workspace in a new tab, by its absolute path", async () => {
    const res = await post({ path: outside, workspacePath: workspace, line: 3, col: 2 });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(outside);
    expect(apply.mock.calls[0][0]).toBe(workspace);
    expect(apply.mock.calls[0][1]).toMatchObject({ type: "new-tab", select: false });
    expect(openedTab().title).toBe("notes.md");
    expect(openedTab().rootNode).toMatchObject({ contentType: "file", filePath: outside });
    expect(showFile).toHaveBeenCalledWith({ paneId: res.body.paneId, path: outside, line: 3, col: 2 });
  });

  it("holds a file inside the workspace by its relative path", async () => {
    const res = await post({ path: path.join(workspace, "src", "a.ts"), workspacePath: workspace });
    expect(res.body.path).toBe("src/a.ts");
    expect(openedTab().rootNode.filePath).toBe("src/a.ts");
  });

  it("brings forward the tab already showing it instead of a second editor", async () => {
    entry = layoutWith([
      {
        id: "t1",
        rootNode: {
          type: "split",
          first: { type: "leaf", paneId: "term" },
          second: { type: "leaf", paneId: "file", contentType: "file", filePath: outside },
        },
      },
    ]);
    const res = await post({ path: outside, workspacePath: workspace });
    expect(res.body).toMatchObject({ paneId: "file", tabId: "t1" });
    expect(apply).not.toHaveBeenCalled();
    expect(showFile).toHaveBeenCalledWith({ paneId: "file", path: outside });
  });

  it("doesn't bring it forward in the background", async () => {
    const res = await post({ path: outside, workspacePath: workspace, background: true });
    expect(res.status).toBe(200);
    expect(apply).toHaveBeenCalled();
    expect(showFile).not.toHaveBeenCalled();
  });

  it("opens an image or a PDF, whose bytes the editor would refuse", async () => {
    const image = path.join(tmp, "a.png");
    fs.writeFileSync(image, Buffer.from([0x89, 0, 1, 2]));
    const res = await post({ path: image, workspacePath: workspace });
    expect(res.status).toBe(200);
    expect(openedTab().rootNode).toMatchObject({ contentType: "file", filePath: image });
    const missing = await post({ path: path.join(tmp, "nope.pdf"), workspacePath: workspace });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/does not exist/);
  });

  it("refuses what the viewer couldn't show, leaving no tab", async () => {
    const missing = await post({ path: path.join(tmp, "nope.txt"), workspacePath: workspace });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/does not exist/);
    const folder = await post({ path: tmp, workspacePath: workspace });
    expect(folder.status).toBe(400);
    expect(folder.body.error).toMatch(/is not a file/);
    const binary = path.join(tmp, "b.bin");
    fs.writeFileSync(binary, Buffer.from([0, 1, 2]));
    expect((await post({ path: binary, workspacePath: workspace })).body.error).toMatch(/binary/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("refuses a relative path and a bad line", async () => {
    expect((await post({ path: "a.ts", workspacePath: workspace })).status).toBe(400);
    expect((await post({ path: outside, workspacePath: workspace, line: 0 })).status).toBe(400);
  });

  it("falls back to the last active workspace when it is on this machine", async () => {
    lastActive = workspace;
    expect((await post({ path: outside })).status).toBe(200);
    expect(apply.mock.calls[0][0]).toBe(workspace);
  });

  it("won't read this machine's path on the last active workspace's other host", async () => {
    lastActive = "box:/on-box";
    const res = await post({ path: outside });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No workspace/);
    expect(control).not.toHaveBeenCalled();
  });

  it("sends a workspace on an adopted host to its server", async () => {
    const res = await post({ path: "/home/me/notes.md", workspacePath: "/on-box", line: 2 });
    expect(res.status).toBe(200);
    expect(control).toHaveBeenCalledWith("box", "POST", "/files/open", {
      path: "/home/me/notes.md",
      workspacePath: "/on-box",
      line: 2,
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
