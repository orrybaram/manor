import { describe, expect, it } from "vitest";
import { AgentFileAuthors, type FileAuthor } from "./agent-file-authors";

const by = (paneId: string, at = 1): FileAuthor => ({ paneId, agentKind: "claude", at });

describe("AgentFileAuthors", () => {
  it("answers a workspace's files by their relative path", () => {
    const authors = new AgentFileAuthors();
    authors.record("/w/src/a.ts", by("p1"));
    authors.record("/w/README.md", by("p2"));
    authors.record("/other/x.ts", by("p3"));
    expect(authors.inWorkspace("/w")).toEqual({
      "src/a.ts": by("p1"),
      "README.md": by("p2"),
    });
    expect(authors.inWorkspace("/w/")).toEqual(authors.inWorkspace("/w"));
  });

  it("keeps the last writer of a file", () => {
    const authors = new AgentFileAuthors();
    authors.record("/w/a.ts", by("p1", 1));
    authors.record("/w/./a.ts", by("p2", 2));
    expect(authors.inWorkspace("/w")).toEqual({ "a.ts": by("p2", 2) });
  });

  it("does not read a sibling folder with the same prefix as the workspace", () => {
    const authors = new AgentFileAuthors();
    authors.record("/w-other/a.ts", by("p1"));
    expect(authors.inWorkspace("/w")).toEqual({});
  });

  it("drops a relative path, which names no file", () => {
    const authors = new AgentFileAuthors();
    authors.record("src/a.ts", by("p1"));
    expect(authors.inWorkspace("/")).toEqual({});
  });

  it("forgets the oldest write past its cap, a rewrite counting as new", () => {
    const authors = new AgentFileAuthors(2);
    authors.record("/w/a", by("p1"));
    authors.record("/w/b", by("p1"));
    authors.record("/w/a", by("p2"));
    authors.record("/w/c", by("p1"));
    expect(Object.keys(authors.inWorkspace("/w")).sort()).toEqual(["a", "c"]);
  });
});
