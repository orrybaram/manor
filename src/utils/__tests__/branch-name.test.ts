import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
  toDirSlug,
  branchesEqual,
} from "../branch-name";

describe("sanitizeBranchName", () => {
  it("preserves case", () => {
    expect(sanitizeBranchName("PROJ-123-MyFeature")).toBe("PROJ-123-MyFeature");
  });

  it("converts internal whitespace to hyphens", () => {
    expect(sanitizeBranchName("My Feature")).toBe("My-Feature");
  });

  it("collapses whitespace runs to a single hyphen", () => {
    expect(sanitizeBranchName("My   Big    Feature")).toBe("My-Big-Feature");
  });

  it("strips git-forbidden characters", () => {
    const result = sanitizeBranchName("feat: do~thing?");
    expect(result).not.toMatch(/[:~?]/);
    expect(result).toBe("feat-dothing");
  });

  it("strips additional forbidden chars and sequences", () => {
    const result = sanitizeBranchName("a^b*c[d\\e@{f}g");
    expect(result).not.toMatch(/[\^*[\\@{}]/);
  });

  it("keeps slashes for namespaced branches", () => {
    expect(sanitizeBranchName("feature/Foo Bar")).toBe("feature/Foo-Bar");
  });

  it("preserves case in namespaced branches", () => {
    expect(sanitizeBranchName("user/PROJ-123")).toBe("user/PROJ-123");
  });

  it("removes a trailing .lock (case-insensitive)", () => {
    expect(sanitizeBranchName("my-branch.lock")).toBe("my-branch");
    expect(sanitizeBranchName("my-branch.LOCK")).toBe("my-branch");
  });

  it("trims leading and trailing separators", () => {
    expect(sanitizeBranchName("  -/.My-Branch./-  ")).toBe("My-Branch");
  });

  it("collapses `..` to `.` and `//` to `/`", () => {
    expect(sanitizeBranchName("feature//foo..bar")).toBe("feature/foo.bar");
  });

  it("collapses repeated hyphens", () => {
    expect(sanitizeBranchName("foo---bar")).toBe("foo-bar");
  });
});

describe("toDirSlug", () => {
  it("lowercases and slugifies", () => {
    expect(toDirSlug("PROJ-123 My Feature")).toBe("proj-123-my-feature");
  });

  it("strips disallowed characters", () => {
    expect(toDirSlug("Hello, World!")).toBe("hello-world");
  });
});

describe("branchesEqual", () => {
  it("matches case-insensitively", () => {
    expect(branchesEqual("MyBranch", "mybranch")).toBe(true);
  });

  it("returns false when values differ", () => {
    expect(branchesEqual("foo", "bar")).toBe(false);
  });

  it("returns false when either value is null/undefined", () => {
    expect(branchesEqual(null, "x")).toBe(false);
    expect(branchesEqual("x", null)).toBe(false);
    expect(branchesEqual(undefined, "x")).toBe(false);
    expect(branchesEqual(null, null)).toBe(false);
  });
});
