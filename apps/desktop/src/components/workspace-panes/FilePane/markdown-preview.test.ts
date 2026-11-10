import { describe, expect, it } from "vitest";
import { fenceFrontmatter, isMarkdownFile, markdownLinkTarget } from "./markdown-preview";

describe("isMarkdownFile", () => {
  it("knows markdown by its extension, in any case", () => {
    expect(isMarkdownFile("docs/README.md")).toBe(true);
    expect(isMarkdownFile("PLAN.MD")).toBe(true);
    expect(isMarkdownFile("a/page.mdx")).toBe(true);
    expect(isMarkdownFile("notes.markdown")).toBe(true);
    expect(isMarkdownFile("md")).toBe(false);
    expect(isMarkdownFile("src/md.ts")).toBe(false);
  });
});

describe("fenceFrontmatter", () => {
  it("fences a leading block, and keeps what follows", () => {
    expect(fenceFrontmatter("---\nname: x\n---\n# Title\n")).toBe(
      "````yaml\nname: x\n````\n\n# Title\n",
    );
  });

  it("reads CRLF files", () => {
    expect(fenceFrontmatter("---\r\nname: x\r\n---\r\n# Title")).toBe(
      "````yaml\nname: x\n````\n\n# Title",
    );
  });

  it("drops an empty block, without reaching for a later rule", () => {
    expect(fenceFrontmatter("---\n---\n# Title\n\n---\nrest")).toBe("# Title\n\n---\nrest");
  });

  it("leaves a document that opens with a rule alone", () => {
    const doc = "---\n\nIntro **text**\n\n## Setup\n\n---\n\nMore";
    expect(fenceFrontmatter(doc)).toBe(doc);
    const prose = "---\nJust a sentence.\n---\nMore";
    expect(fenceFrontmatter(prose)).toBe(prose);
  });

  it("leaves a file without frontmatter, and a rule later on, alone", () => {
    expect(fenceFrontmatter("# Title\n\n---\n\nafter\n---\n")).toBe("# Title\n\n---\n\nafter\n---\n");
    expect(fenceFrontmatter("---\nnever closed\n")).toBe("---\nnever closed\n");
  });
});

describe("markdownLinkTarget", () => {
  it("resolves against the file's folder", () => {
    expect(markdownLinkTarget("docs/guide/a.md", "b.md")).toBe("docs/guide/b.md");
    expect(markdownLinkTarget("docs/guide/a.md", "./b.md")).toBe("docs/guide/b.md");
    expect(markdownLinkTarget("docs/guide/a.md", "../b.md")).toBe("docs/b.md");
    expect(markdownLinkTarget("README.md", "docs/a.md")).toBe("docs/a.md");
  });

  it("starts a leading slash from the workspace", () => {
    expect(markdownLinkTarget("docs/a.md", "/src/b.ts")).toBe("src/b.ts");
  });

  it("drops the query and anchor, and decodes", () => {
    expect(markdownLinkTarget("a.md", "b.md#setup")).toBe("b.md");
    expect(markdownLinkTarget("a.md", "b.md?plain=1#L3")).toBe("b.md");
    expect(markdownLinkTarget("a.md", "my%20notes.md")).toBe("my notes.md");
  });

  it("stays absolute for a file outside the workspace", () => {
    expect(markdownLinkTarget("/home/me/a.md", "b.md")).toBe("/home/me/b.md");
    expect(markdownLinkTarget("/home/me/a.md", "../../../b.md")).toBe("/b.md");
    expect(markdownLinkTarget("/home/me/a.md", "/etc/b.md")).toBe("/etc/b.md");
  });

  it("refuses what is no file in the workspace", () => {
    expect(markdownLinkTarget("a.md", "https://example.com/b.md")).toBeNull();
    expect(markdownLinkTarget("a.md", "mailto:me@example.com")).toBeNull();
    expect(markdownLinkTarget("a.md", "//example.com/b.md")).toBeNull();
    expect(markdownLinkTarget("a.md", "#setup")).toBeNull();
    expect(markdownLinkTarget("docs/a.md", "../../b.md")).toBeNull();
    expect(markdownLinkTarget("a.md", "%E0%A4%A")).toBeNull();
    expect(markdownLinkTarget("docs/a.md", "..")).toBeNull();
    expect(markdownLinkTarget("a.md", "docs/")).toBeNull();
  });
});
