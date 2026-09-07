/**
 * MCP tools for git (ADR-171): thin wrappers over `/git/*`
 * (`../routes/git.ts`), itself a thin wrapper over `backend.git`. Every tool
 * takes an optional `cwd`, defaulting through `resolveWorkspacePath` to the
 * workspace this agent is running in — the control server 400s if it isn't a
 * known workspace path of some project.
 */

import { resolveWorkspacePath } from "./context";
import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

/** Shared by every tool below. */
const CWD_PROP = {
  type: "string",
  description:
    "Workspace directory to run git in. Defaults to the workspace this agent is running in.",
} as const;

const FILES_PROP = {
  type: "array",
  items: { type: "string" },
  description: "File paths, relative to 'cwd'.",
} as const;

/** The wire shape `POST /git/push` returns. */
interface PushResult {
  exitCode: number | null;
  lines: string[];
  stderr: string;
}

// `POST /git/push` blocks for the duration of the push; the control server
// guards it with a 5-minute timer and responds 504 itself, so the client
// timeout only needs to outlast that, not race it.
const PUSH_CLIENT_TIMEOUT_MS = 5 * 60 * 1000 + 15_000;

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "git_stage",
    description: "Stage files for commit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        files: FILES_PROP,
      },
      required: ["files"],
    },
  },
  {
    name: "git_unstage",
    description: "Unstage files, leaving their changes in the working tree.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        files: FILES_PROP,
      },
      required: ["files"],
    },
  },
  {
    name: "git_discard",
    description:
      "Destructive: permanently discards uncommitted changes to the given files. Cannot be undone — check git_diff first if you aren't sure what you're about to lose.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        files: FILES_PROP,
      },
      required: ["files"],
    },
  },
  {
    name: "git_stash",
    description: "Stash uncommitted changes to the given files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        files: FILES_PROP,
      },
      required: ["files"],
    },
  },
  {
    name: "git_commit",
    description: "Commit staged changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        message: { type: "string", description: "Commit message." },
        flags: {
          type: "array",
          items: { type: "string" },
          description: "Extra flags passed to 'git commit' (e.g. '--amend').",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "git_push",
    description:
      "Push commits to a remote. Blocks until the push finishes (or times out after 5 minutes), then returns the collected output and exit code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        remote: {
          type: "string",
          description: "Remote to push to. Defaults to the branch's remote.",
        },
        branch: {
          type: "string",
          description: "Branch to push. Defaults to the current branch.",
        },
        setUpstream: {
          type: "boolean",
          description: "Set the pushed branch's upstream tracking branch.",
        },
      },
    },
  },
  {
    name: "git_staged_files",
    description: "List files currently staged for commit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
      },
    },
  },
  {
    name: "git_diff",
    description:
      "Show a diff: 'local' (default) for uncommitted changes, 'full' for everything different from the project's default branch.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: CWD_PROP,
        scope: {
          type: "string",
          enum: ["local", "full"],
          description: "Which diff to show. Defaults to 'local'.",
        },
      },
    },
  },
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async git_stage(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const files = args.files as string[];
    await http.post("/git/stage", { cwd, files });
    return text(`Staged ${files.length} file(s) in ${cwd}.`);
  },

  async git_unstage(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const files = args.files as string[];
    await http.post("/git/unstage", { cwd, files });
    return text(`Unstaged ${files.length} file(s) in ${cwd}.`);
  },

  async git_discard(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const files = args.files as string[];
    await http.post("/git/discard", { cwd, files });
    return text(`Discarded changes to ${files.length} file(s) in ${cwd}.`);
  },

  async git_stash(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const files = args.files as string[];
    await http.post("/git/stash", { cwd, files });
    return text(`Stashed ${files.length} file(s) in ${cwd}.`);
  },

  async git_commit(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const body: Record<string, unknown> = { cwd, message: args.message };
    if (args.flags !== undefined) body.flags = args.flags;
    await http.post("/git/commit", body);
    return text(`Committed in ${cwd}: ${args.message as string}`);
  },

  async git_push(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const body: Record<string, unknown> = { cwd };
    if (args.remote !== undefined) body.remote = args.remote;
    if (args.branch !== undefined) body.branch = args.branch;
    if (args.setUpstream !== undefined) body.setUpstream = args.setUpstream;
    const result = (await http.post(
      "/git/push",
      body,
      PUSH_CLIENT_TIMEOUT_MS,
    )) as PushResult;
    const output =
      result.lines.length > 0 ? `${result.lines.join("\n")}\n\n` : "";
    return text(`${output}Exit code: ${result.exitCode ?? "unknown"}`);
  },

  async git_staged_files(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const files = (await http.get(
      `/git/staged-files?cwd=${encodeURIComponent(cwd)}`,
    )) as string[];
    if (files.length === 0) return text(`No staged files in ${cwd}.`);
    return text(files.join("\n"));
  },

  async git_diff(args, http) {
    const cwd = await resolveWorkspacePath(
      http,
      args.cwd as string | undefined,
    );
    const scope = (args.scope as string | undefined) ?? "local";
    const diff = (await http.get(
      `/git/diff?cwd=${encodeURIComponent(cwd)}&scope=${encodeURIComponent(scope)}`,
    )) as string | null;
    return text(diff ? diff : "No changes.");
  },
};

export const gitModule: ToolModule = { tools, handlers };
