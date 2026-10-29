import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";

const find = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock("../workspace-file-index", () => ({ workspaceFileIndex: { find } }));

const { createFileLinkProvider } = await import("../file-link-provider");

/** A terminal whose one buffer line reads `text`. */
function terminalWith(text: string): Terminal {
  return {
    buffer: { active: { getLine: () => ({ translateToString: () => text }) } },
  } as unknown as Terminal;
}

function linksFor(text: string, hostId: string): Promise<ILink[] | undefined> {
  const provider = createFileLinkProvider({
    terminal: terminalWith(text),
    paneId: "p1",
    fallbackCwd: "/repo",
    workspace: { path: "/repo", hostId },
    hover: () => {},
    leave: () => {},
    open: () => {},
  });
  return new Promise((resolve) => provider.provideLinks(1, resolve));
}

const resolveFilePath = vi.fn(async (path: string) => `/repo/${path}`);

beforeEach(() => {
  find.mockReset().mockResolvedValue(null);
  resolveFilePath.mockClear();
  vi.stubGlobal("window", { electronAPI: { shell: { resolveFilePath } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("createFileLinkProvider", () => {
  it("falls back to this machine's disk for a local workspace", async () => {
    const links = await linksFor("see notes.md", "local");
    expect(resolveFilePath).toHaveBeenCalledWith("notes.md", "/repo");
    expect(links?.map((l) => l.text)).toEqual(["notes.md"]);
  });

  it("never reads this machine's disk for a workspace on another host", async () => {
    const links = await linksFor("see notes.md", "box");
    expect(resolveFilePath).not.toHaveBeenCalled();
    expect(links).toBeUndefined();
  });

  it("links a remote workspace's own files", async () => {
    find.mockResolvedValue("notes.md");
    const links = await linksFor("see notes.md", "box");
    expect(links?.map((l) => l.text)).toEqual(["notes.md"]);
  });
});
