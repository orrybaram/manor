import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
  toDirSlug,
  branchesEqual,
} from "./branch-name";

describe("sanitizeBranchName", () => {
  describe("emoji removal", () => {
    it("removes emoji from the start", () => {
      expect(sanitizeBranchName("🚀 Launch")).toBe("Launch");
    });

    it("removes emoji from the middle without creating double hyphens", () => {
      expect(sanitizeBranchName("fix 👍🏽 thing")).toBe("fix-thing");
    });

    it("removes emoji with zero-width joiners (family emoji)", () => {
      expect(sanitizeBranchName("👨‍👩‍👧 family")).toBe("family");
    });

    it("preserves digits and hash after emoji removal", () => {
      expect(sanitizeBranchName("v2 #1")).toBe("v2-#1");
    });

    it("removes multiple emoji in sequence", () => {
      expect(sanitizeBranchName("🚀🎯 test")).toBe("test");
    });

    it("removes emoji with variation selectors", () => {
      expect(sanitizeBranchName("heart ❤️ love")).toBe("heart-love");
    });

    it("removes emoji modifiers", () => {
      expect(sanitizeBranchName("wave 👋🏽 hello")).toBe("wave-hello");
    });
  });

  describe("existing functionality", () => {
    it("trims surrounding whitespace", () => {
      expect(sanitizeBranchName("  feature  ")).toBe("feature");
    });

    it("converts internal whitespace runs to single hyphen", () => {
      expect(sanitizeBranchName("fix   bug")).toBe("fix-bug");
    });

    it("strips git-forbidden characters", () => {
      expect(sanitizeBranchName("fix:bug~123")).toBe("fixbug123");
    });

    it("strips brackets and backslashes", () => {
      expect(sanitizeBranchName("fix[bug\\path")).toBe("fixbugpath");
    });

    it("strips @ and curly braces", () => {
      expect(sanitizeBranchName("feature@{1}")).toBe("feature1");
    });

    it("collapses repeated dots", () => {
      expect(sanitizeBranchName("fix..bug")).toBe("fix.bug");
    });

    it("collapses repeated slashes", () => {
      expect(sanitizeBranchName("path//to//branch")).toBe("path/to/branch");
    });

    it("collapses repeated hyphens", () => {
      expect(sanitizeBranchName("fix--bug")).toBe("fix-bug");
    });

    it("removes trailing .lock", () => {
      expect(sanitizeBranchName("branch.lock")).toBe("branch");
    });

    it("removes trailing .lock case-insensitively", () => {
      expect(sanitizeBranchName("branch.LOCK")).toBe("branch");
    });

    it("trims leading separators", () => {
      expect(sanitizeBranchName("-./feature")).toBe("feature");
    });

    it("trims trailing separators", () => {
      expect(sanitizeBranchName("feature-./")).toBe("feature");
    });

    it("preserves casing", () => {
      expect(sanitizeBranchName("FeatureBranch")).toBe("FeatureBranch");
    });
  });

  describe("complex cases", () => {
    it("combines emoji removal with whitespace and punctuation handling", () => {
      expect(sanitizeBranchName("🎉 New::Feature~Name")).toBe("NewFeatureName");
    });

    it("handles emoji after punctuation that gets stripped", () => {
      expect(sanitizeBranchName("fix:🚀bug")).toBe("fixbug");
    });

    it("handles multiple emoji with spaces", () => {
      expect(sanitizeBranchName("🚀 🎯 launch")).toBe("launch");
    });

    it("maintains namespaced branches with emoji", () => {
      expect(sanitizeBranchName("🚀 feature/branch")).toBe("feature/branch");
    });

    it("preserves numbers and # after emoji removal", () => {
      expect(sanitizeBranchName("fix 🐛 #123 issue")).toBe("fix-#123-issue");
    });
  });
});

describe("toDirSlug", () => {
  it("lowercases the input", () => {
    expect(toDirSlug("FeatureBranch")).toBe("featurebranch");
  });

  it("removes non-alphanumeric characters", () => {
    expect(toDirSlug("fix@branch~123")).toBe("fixbranch123");
  });

  it("converts whitespace to hyphens", () => {
    expect(toDirSlug("fix bug")).toBe("fix-bug");
  });

  it("collapses repeated hyphens", () => {
    expect(toDirSlug("fix--bug")).toBe("fix-bug");
  });

  it("removes leading and trailing hyphens", () => {
    expect(toDirSlug("-fix-bug-")).toBe("fix-bug");
  });
});

describe("branchesEqual", () => {
  it("returns true for identical strings", () => {
    expect(branchesEqual("feature", "feature")).toBe(true);
  });

  it("returns true for case-insensitive match", () => {
    expect(branchesEqual("Feature", "feature")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(branchesEqual("feature", "bugfix")).toBe(false);
  });

  it("returns false when first argument is null", () => {
    expect(branchesEqual(null, "feature")).toBe(false);
  });

  it("returns false when second argument is null", () => {
    expect(branchesEqual("feature", null)).toBe(false);
  });

  it("returns false when both arguments are null", () => {
    expect(branchesEqual(null, null)).toBe(false);
  });

  it("returns false when first argument is undefined", () => {
    expect(branchesEqual(undefined, "feature")).toBe(false);
  });

  it("returns false when second argument is undefined", () => {
    expect(branchesEqual("feature", undefined)).toBe(false);
  });
});
