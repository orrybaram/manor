export type PushErrorKind =
  | "no-upstream"
  | "non-fast-forward"
  | "auth"
  | "network"
  | "permission"
  | "hook-rejected"
  | "unknown";

export type PushError = {
  kind: PushErrorKind;
  message: string;
  action?: { kind: "set-upstream" | "pull-and-retry"; label: string };
};

export function categorizePushError(stderr: string): PushError {
  // no-upstream
  if (
    stderr.includes("has no upstream branch") ||
    stderr.includes("set-upstream") ||
    /current branch .+ has no upstream/i.test(stderr)
  ) {
    return {
      kind: "no-upstream",
      message: "No upstream branch — first push needs `--set-upstream`.",
      action: { kind: "set-upstream", label: "Push with --set-upstream" },
    };
  }

  // non-fast-forward — check before hook-rejected since a hook stderr may also include "rejected"
  if (
    stderr.includes("non-fast-forward") ||
    stderr.includes("Updates were rejected because the tip") ||
    stderr.includes("failed to push some refs")
  ) {
    return {
      kind: "non-fast-forward",
      message: "Remote has new commits — pull first.",
      action: { kind: "pull-and-retry", label: "Pull & retry" },
    };
  }

  // network — check before auth because real git errors often prefix with
  // "unable to access" followed by a network-specific reason
  if (
    stderr.includes("Could not resolve host") ||
    stderr.includes("Connection timed out") ||
    stderr.includes("Network is unreachable") ||
    stderr.includes("Failed to connect")
  ) {
    return {
      kind: "network",
      message: "Network error — check your connection.",
    };
  }

  // auth
  if (
    stderr.includes("Authentication failed") ||
    stderr.includes("could not read Username") ||
    stderr.includes("terminal prompts disabled") ||
    stderr.includes("unable to access")
  ) {
    return {
      kind: "auth",
      message: "Authentication failed — check your credentials.",
    };
  }

  // permission (SSH)
  if (
    stderr.includes("Permission denied (publickey)") ||
    stderr.includes("Permission denied (publickey,password)")
  ) {
    return {
      kind: "permission",
      message: "SSH permission denied — check your key.",
    };
  }

  // hook-rejected: stderr mentions pre-push hook or "hook declined",
  // or the first non-empty line ends with "rejected"
  if (stderr.includes("pre-push hook") || stderr.includes("hook declined")) {
    return {
      kind: "hook-rejected",
      message: "Pre-push hook rejected the push.",
    };
  }

  const firstNonEmptyLine = stderr
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (firstNonEmptyLine !== undefined && firstNonEmptyLine.trim().endsWith("rejected")) {
    return {
      kind: "hook-rejected",
      message: "Pre-push hook rejected the push.",
    };
  }

  // unknown fallback
  const lines = stderr.split("\n");
  const lastNonEmptyLine = lines
    .slice()
    .reverse()
    .find((line) => line.trim().length > 0);

  return {
    kind: "unknown",
    message: lastNonEmptyLine ?? (stderr.trim() === "" ? "Push failed" : stderr.trim()),
  };
}
