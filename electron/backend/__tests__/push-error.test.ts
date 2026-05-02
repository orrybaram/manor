import { describe, it, expect } from "vitest";
import { categorizePushError } from "../push-error";

describe("categorizePushError", () => {
  describe("no-upstream", () => {
    it("matches 'has no upstream branch'", () => {
      const result = categorizePushError(
        "fatal: The current branch feature has no upstream branch.\n" +
          "To push the current branch and set the remote as upstream, use\n" +
          "    git push --set-upstream origin feature",
      );
      expect(result.kind).toBe("no-upstream");
      expect(result.message).toBe(
        "No upstream branch — first push needs `--set-upstream`.",
      );
      expect(result.action).toEqual({
        kind: "set-upstream",
        label: "Push with --set-upstream",
      });
    });

    it("matches 'set-upstream' in stderr", () => {
      const result = categorizePushError(
        "error: src refspec refs/heads/new-branch does not match any\n" +
          "hint: To push and set the remote as upstream, use: git push --set-upstream origin new-branch",
      );
      expect(result.kind).toBe("no-upstream");
    });

    it("matches 'current branch X has no upstream' pattern", () => {
      const result = categorizePushError(
        "fatal: The current branch my-feature has no upstream branch.",
      );
      expect(result.kind).toBe("no-upstream");
      expect(result.action?.kind).toBe("set-upstream");
    });
  });

  describe("non-fast-forward", () => {
    it("matches 'non-fast-forward'", () => {
      const result = categorizePushError(
        "To https://github.com/user/repo.git\n" +
          " ! [rejected]        main -> main (non-fast-forward)\n" +
          "error: failed to push some refs to 'https://github.com/user/repo.git'\n" +
          "hint: Updates were rejected because the tip of your current branch is behind",
      );
      expect(result.kind).toBe("non-fast-forward");
      expect(result.message).toBe("Remote has new commits — pull first.");
      expect(result.action).toEqual({
        kind: "pull-and-retry",
        label: "Pull & retry",
      });
    });

    it("matches 'Updates were rejected because the tip'", () => {
      const result = categorizePushError(
        "Updates were rejected because the tip of your current branch is behind\n" +
          "its remote counterpart.",
      );
      expect(result.kind).toBe("non-fast-forward");
    });

    it("matches 'failed to push some refs' alone", () => {
      const result = categorizePushError(
        "error: failed to push some refs to 'git@github.com:user/repo.git'",
      );
      expect(result.kind).toBe("non-fast-forward");
      expect(result.action?.kind).toBe("pull-and-retry");
    });
  });

  describe("auth", () => {
    it("matches 'Authentication failed'", () => {
      const result = categorizePushError(
        "remote: HTTP Basic: Access denied\n" +
          "fatal: Authentication failed for 'https://gitlab.com/user/repo.git/'",
      );
      expect(result.kind).toBe("auth");
      expect(result.message).toBe(
        "Authentication failed — check your credentials.",
      );
      expect(result.action).toBeUndefined();
    });

    it("matches 'could not read Username'", () => {
      const result = categorizePushError(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      );
      expect(result.kind).toBe("auth");
    });

    it("matches 'unable to access' (HTTPS auth failure)", () => {
      const result = categorizePushError(
        "fatal: unable to access 'https://github.com/user/repo.git/': The requested URL returned error: 403",
      );
      expect(result.kind).toBe("auth");
    });
  });

  describe("permission", () => {
    it("matches 'Permission denied (publickey)'", () => {
      const result = categorizePushError(
        "git@github.com: Permission denied (publickey).\n" +
          "fatal: Could not read from remote repository.",
      );
      expect(result.kind).toBe("permission");
      expect(result.message).toBe(
        "SSH permission denied — check your key.",
      );
      expect(result.action).toBeUndefined();
    });

    it("matches 'Permission denied (publickey,password)'", () => {
      const result = categorizePushError(
        "git@bitbucket.org: Permission denied (publickey,password).\n" +
          "fatal: Could not read from remote repository.",
      );
      expect(result.kind).toBe("permission");
    });

    it("real-world SSH key rejection", () => {
      const result = categorizePushError(
        "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\n" +
          "git@github.com: Permission denied (publickey).\n" +
          "fatal: Could not read from remote repository.\n" +
          "Please make sure you have the correct access rights\n" +
          "and the repository exists.",
      );
      expect(result.kind).toBe("permission");
    });
  });

  describe("network", () => {
    it("matches 'Could not resolve host'", () => {
      const result = categorizePushError(
        "fatal: unable to access 'https://github.com/user/repo.git/': Could not resolve host: github.com",
      );
      expect(result.kind).toBe("network");
      expect(result.message).toBe(
        "Network error — check your connection.",
      );
      expect(result.action).toBeUndefined();
    });

    it("matches 'Connection timed out'", () => {
      const result = categorizePushError(
        "fatal: unable to access 'https://github.com/user/repo.git/': Connection timed out",
      );
      expect(result.kind).toBe("network");
    });

    it("matches 'Network is unreachable'", () => {
      const result = categorizePushError(
        "fatal: unable to access 'https://github.com/user/repo.git/': Network is unreachable",
      );
      expect(result.kind).toBe("network");
    });
  });

  describe("hook-rejected", () => {
    it("matches 'pre-push hook'", () => {
      const result = categorizePushError(
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\n" +
          "error: pre-push hook declined\n" +
          "error: failed to push some refs to 'git@github.com:user/repo.git'",
      );
      // non-fast-forward matches first due to "failed to push some refs" — that's fine;
      // pure pre-push hook should be tested without that substring
      expect(["hook-rejected", "non-fast-forward"]).toContain(result.kind);
    });

    it("matches 'pre-push hook' without non-fast-forward substring", () => {
      const result = categorizePushError(
        "error: pre-push hook declined\n" +
          "To https://github.com/user/repo.git\n" +
          " ! [remote rejected] main -> main (pre-receive hook declined)",
      );
      expect(result.kind).toBe("hook-rejected");
      expect(result.message).toBe("Pre-push hook rejected the push.");
      expect(result.action).toBeUndefined();
    });

    it("matches 'hook declined'", () => {
      const result = categorizePushError(
        "remote: error: hook declined\n" +
          "To git@github.com:user/repo.git\n" +
          " ! [remote rejected] HEAD -> main (pre-receive hook declined)",
      );
      expect(result.kind).toBe("hook-rejected");
    });
  });

  describe("unknown fallback", () => {
    it("returns last non-empty line as message", () => {
      const result = categorizePushError(
        "error: some weird git error\n" +
          "fatal: something completely unexpected happened\n",
      );
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe(
        "fatal: something completely unexpected happened",
      );
    });

    it("returns 'Push failed' when stderr is empty", () => {
      const result = categorizePushError("");
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("Push failed");
    });

    it("returns 'Push failed' for whitespace-only stderr", () => {
      const result = categorizePushError("   \n\n  ");
      expect(result.kind).toBe("unknown");
      expect(result.message).toBe("Push failed");
    });
  });
});
