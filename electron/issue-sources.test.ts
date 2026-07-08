import { describe, it, expect } from "vitest";
import {
  isIssueSource,
  parseIssueState,
  linearStateTypes,
  normalizeGitHubIssue,
  normalizeLinearIssue,
  normalizeGitHubIssueDetail,
  normalizeLinearIssueDetail,
} from "./issue-sources";
import type { GitHubIssue, GitHubIssueDetail } from "./github";
import type { LinearIssue, LinearIssueDetail } from "./linear";

describe("issue-sources", () => {
  // ─── isIssueSource ────────────────────────────────────────────────────────

  describe("isIssueSource", () => {
    it("accepts 'github' and 'linear'", () => {
      expect(isIssueSource("github")).toBe(true);
      expect(isIssueSource("linear")).toBe(true);
    });

    it("rejects unknown strings and non-strings", () => {
      expect(isIssueSource("gitlab")).toBe(false);
      expect(isIssueSource("")).toBe(false);
      expect(isIssueSource(null)).toBe(false);
      expect(isIssueSource(undefined)).toBe(false);
      expect(isIssueSource(42)).toBe(false);
    });
  });

  // ─── parseIssueState ──────────────────────────────────────────────────────

  describe("parseIssueState", () => {
    it("passes through valid states", () => {
      expect(parseIssueState("open")).toBe("open");
      expect(parseIssueState("closed")).toBe("closed");
      expect(parseIssueState("all")).toBe("all");
    });

    it("defaults to 'open' for null", () => {
      expect(parseIssueState(null)).toBe("open");
    });

    it("defaults to 'open' for garbage input", () => {
      expect(parseIssueState("bogus")).toBe("open");
      expect(parseIssueState("")).toBe("open");
      expect(parseIssueState("OPEN")).toBe("open");
    });
  });

  // ─── linearStateTypes ─────────────────────────────────────────────────────

  describe("linearStateTypes", () => {
    it("maps 'open' to triage/backlog/unstarted/started", () => {
      expect(linearStateTypes("open")).toEqual([
        "triage",
        "backlog",
        "unstarted",
        "started",
      ]);
    });

    it("maps 'closed' to completed/canceled", () => {
      expect(linearStateTypes("closed")).toEqual(["completed", "canceled"]);
    });

    it("maps 'all' to all six state types, open first", () => {
      expect(linearStateTypes("all")).toEqual([
        "triage",
        "backlog",
        "unstarted",
        "started",
        "completed",
        "canceled",
      ]);
    });
  });

  // ─── normalizeGitHubIssue ─────────────────────────────────────────────────

  describe("normalizeGitHubIssue", () => {
    it("normalizes a full GitHub issue", () => {
      const issue: GitHubIssue = {
        number: 42,
        title: "Fix the thing",
        url: "https://github.com/o/r/issues/42",
        state: "open",
        labels: [{ name: "bug", color: "red" }],
        assignees: [{ login: "orrybaram" }],
      };

      expect(normalizeGitHubIssue(issue)).toEqual({
        source: "github",
        ref: "#42",
        title: "Fix the thing",
        url: "https://github.com/o/r/issues/42",
        state: "open",
        labels: ["bug"],
      });
    });

    it("coalesces missing labels to []", () => {
      const issue = {
        number: 7,
        title: "No labels",
        url: "https://github.com/o/r/issues/7",
        state: "open",
        assignees: [],
      } as unknown as GitHubIssue;

      expect(normalizeGitHubIssue(issue).labels).toEqual([]);
    });

    // `id` was a second lookup key nobody read; `ref` is the only one. Linear's
    // input carries its own `id` (a UUID) — the normalizer must not forward it.
    it("emits no `id` field, for either source", () => {
      const gh = { number: 42, labels: [] } as unknown as GitHubIssue;
      const lin = {
        id: "uuid-1",
        identifier: "ENG-1",
        state: { name: "Backlog", type: "backlog" },
        labels: [],
      } as unknown as LinearIssue;
      expect("id" in normalizeGitHubIssue(gh)).toBe(false);
      expect("id" in normalizeLinearIssue(lin)).toBe(false);
      expect("id" in normalizeLinearIssueDetail(lin as LinearIssueDetail)).toBe(
        false,
      );
    });
  });

  // ─── normalizeLinearIssue ─────────────────────────────────────────────────

  describe("normalizeLinearIssue", () => {
    it("normalizes a full Linear issue", () => {
      const issue: LinearIssue = {
        id: "uuid-1",
        identifier: "ENG-123",
        title: "Ship feature",
        url: "https://linear.app/o/issue/ENG-123",
        branchName: "eng-123-ship-feature",
        priority: 2,
        state: { name: "In Progress", type: "started" },
        labels: [{ name: "feature", color: "blue" }],
      };

      expect(normalizeLinearIssue(issue)).toEqual({
        source: "linear",
        ref: "ENG-123",
        title: "Ship feature",
        url: "https://linear.app/o/issue/ENG-123",
        state: "In Progress",
        labels: ["feature"],
      });
    });

    it("coalesces missing labels to []", () => {
      const issue = {
        id: "uuid-2",
        identifier: "ENG-999",
        title: "No labels",
        url: "https://linear.app/o/issue/ENG-999",
        branchName: "eng-999",
        priority: 0,
        state: { name: "Backlog", type: "backlog" },
      } as unknown as LinearIssue;

      expect(normalizeLinearIssue(issue).labels).toEqual([]);
    });
  });

  // ─── normalizeGitHubIssueDetail ───────────────────────────────────────────

  describe("normalizeGitHubIssueDetail", () => {
    it("normalizes a full GitHub issue detail", () => {
      const detail: GitHubIssueDetail = {
        number: 42,
        title: "Fix the thing",
        url: "https://github.com/o/r/issues/42",
        state: "open",
        labels: [{ name: "bug", color: "red" }],
        assignees: [{ login: "orrybaram" }, { login: "octocat" }],
        body: "Here's the repro steps.",
        milestone: null,
      };

      expect(normalizeGitHubIssueDetail(detail)).toEqual({
        source: "github",
        ref: "#42",
        title: "Fix the thing",
        url: "https://github.com/o/r/issues/42",
        state: "open",
        labels: ["bug"],
        body: "Here's the repro steps.",
        assignees: ["orrybaram", "octocat"],
      });
    });

    it("coalesces missing labels/assignees to []", () => {
      const detail = {
        number: 7,
        title: "No labels or assignees",
        url: "https://github.com/o/r/issues/7",
        state: "closed",
        body: null,
        milestone: null,
      } as unknown as GitHubIssueDetail;

      const result = normalizeGitHubIssueDetail(detail);
      expect(result.labels).toEqual([]);
      expect(result.assignees).toEqual([]);
    });
  });

  // ─── normalizeLinearIssueDetail ───────────────────────────────────────────

  describe("normalizeLinearIssueDetail", () => {
    it("normalizes a full Linear issue detail with an assignee", () => {
      const detail: LinearIssueDetail = {
        id: "uuid-1",
        identifier: "ENG-123",
        title: "Ship feature",
        url: "https://linear.app/o/issue/ENG-123",
        branchName: "eng-123-ship-feature",
        priority: 2,
        state: { name: "In Progress", type: "started" },
        labels: [{ id: "l1", name: "feature", color: "blue" }],
        description: "Some description.",
        assignee: {
          id: "u1",
          name: "Orry Baram",
          displayName: "orry",
          avatarUrl: null,
        },
      };

      expect(normalizeLinearIssueDetail(detail)).toEqual({
        source: "linear",
        ref: "ENG-123",
        title: "Ship feature",
        url: "https://linear.app/o/issue/ENG-123",
        state: "In Progress",
        labels: ["feature"],
        body: "Some description.",
        assignees: ["orry"],
      });
    });

    it("yields an empty assignees array when unassigned", () => {
      const detail: LinearIssueDetail = {
        id: "uuid-2",
        identifier: "ENG-999",
        title: "Unassigned",
        url: "https://linear.app/o/issue/ENG-999",
        branchName: "eng-999",
        priority: 0,
        state: { name: "Backlog", type: "backlog" },
        labels: [],
        description: null,
        assignee: null,
      };

      expect(normalizeLinearIssueDetail(detail).assignees).toEqual([]);
    });

    it("coalesces missing labels to []", () => {
      const detail = {
        id: "uuid-3",
        identifier: "ENG-1",
        title: "No labels",
        url: "https://linear.app/o/issue/ENG-1",
        branchName: "eng-1",
        priority: 0,
        state: { name: "Backlog", type: "backlog" },
        description: null,
        assignee: null,
      } as unknown as LinearIssueDetail;

      expect(normalizeLinearIssueDetail(detail).labels).toEqual([]);
    });
  });
});
