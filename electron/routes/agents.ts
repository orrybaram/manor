/**
 * `/agents` — live session state, read-only. This is the "see every session"
 * surface `list_agents` (`electron/mcp/tools-sessions.ts`) proxies: every
 * `AgentInfo` the `AgentManager` (`../agent-persistence.ts`) knows about,
 * regardless of which project or workspace it belongs to.
 *
 * Entirely main-served — `agentManager` already lives in the main process, so
 * unlike the pane/tab routes there is no renderer round-trip here.
 */

import type { AgentInfo, AgentManager } from "../agent-persistence";
import { startAgent } from "../renderer-bridge";
import { interruptSequenceFor } from "../harness-interrupt";
import { stripAnsi } from "../terminal-host/output-pattern-matcher";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type { ControlDeps, Route } from "./types";

/** The wire shape `GET /agents` returns — a curated slice of `AgentInfo`. */
export interface AgentSummary {
  id: string;
  name: string | null;
  status: AgentInfo["status"];
  lastAgentStatus: string | null;
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  agentKind: AgentInfo["agentKind"];
  paneId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  activatedAt: string | null;
}

function toSummary(agent: AgentInfo): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    lastAgentStatus: agent.lastAgentStatus,
    projectId: agent.projectId,
    projectName: agent.projectName,
    workspacePath: agent.workspacePath,
    agentKind: agent.agentKind,
    paneId: agent.paneId,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    completedAt: agent.completedAt,
    activatedAt: agent.activatedAt,
  };
}

/**
 * Resolve a `send_to_session` `target` — deliberately forgiving so the
 * orchestrator can reuse whatever handle it has to hand: the agent `id`
 * (`list_agents`'s stable handle), a raw `paneId`, `#<issue>`, or the workspace
 * branch. Returns the matching `AgentInfo`, or `null` if nothing matches.
 *
 * Exact identifiers (id, paneId) win before the fuzzier branch/issue scan, and
 * that scan only ever considers *active* agents — steering a completed session
 * is meaningless and would surprise the caller.
 */
function resolveTarget(
  agentManager: AgentManager,
  target: string,
): AgentInfo | null {
  // 1. Stable agent id (what list_agents hands back).
  const byId = agentManager.getAgentById(target);
  if (byId) return byId;

  // 2. Raw pane id.
  const byPane = agentManager.getAgentByPaneId(target);
  if (byPane) return byPane;

  const active = agentManager.getActiveAgents();

  // 3. `#<issue>` — the branch/workspace for an issue conventionally leads with
  //    the issue number (e.g. `159-add-orchestration-ux`), so match a workspace
  //    path segment that is exactly the number or is prefixed `<number>-`.
  const issueMatch = target.match(/^#(\d+)$/);
  if (issueMatch) {
    const issue = issueMatch[1];
    const byIssue = active.find((t) => {
      if (!t.workspacePath) return false;
      const base = t.workspacePath.split("/").pop() ?? "";
      return base === issue || base.startsWith(`${issue}-`);
    });
    if (byIssue) return byIssue;
  }

  // 4. Workspace branch — match the trailing path segment, or the whole path.
  const byBranch = active.find((t) => {
    if (!t.workspacePath) return false;
    const base = t.workspacePath.split("/").pop() ?? "";
    return base === target || t.workspacePath.endsWith(`/${target}`);
  });
  if (byBranch) return byBranch;

  // 5. Human-readable agent name, as a last resort.
  return active.find((t) => t.name === target) ?? null;
}

/**
 * Everything both write routes need before they may touch a pty.
 *
 * `/sessions/send` and `/sessions/interrupt` differ in exactly two ways —
 * whether text is required, and whether a prompt follows the interrupt. Every
 * other step is shared, so it happens here once: the deps are present, the
 * target resolves to a session, that session still has a live pane, and this
 * harness's interrupt sequence is known.
 *
 * `write` is bound to the pane, so neither handler needs a non-null assertion
 * on `deps.backend` after this has checked it. `result` is the 200 body, built
 * *now* — which makes the ordering rule structural rather than a comment: the
 * `lastAgentStatus` a caller gets back is the one from before anything
 * interrupted, because it was read before the caller could write.
 */
type PreparedWrite =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      write: (data: string) => void;
      interrupt: string;
      result: { ok: true; target: TargetResult };
    };

interface TargetResult {
  id: string;
  paneId: string;
  lastAgentStatus: string | null;
}

function prepareWrite(
  deps: ControlDeps,
  body: Record<string, unknown>,
): PreparedWrite {
  if (!deps.agentManager) {
    return {
      ok: false,
      status: 503,
      error: "Agent management is not available",
    };
  }
  if (!deps.backend) {
    return {
      ok: false,
      status: 503,
      error: "Session backend is not available",
    };
  }

  const target = body.target;
  if (typeof target !== "string" || target.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Missing 'target' string in request body",
    };
  }

  const agent = resolveTarget(deps.agentManager, target);
  if (!agent) {
    return {
      ok: false,
      status: 404,
      error: `No session matches target '${target}'`,
    };
  }
  const { paneId } = agent;
  if (!paneId) {
    return {
      ok: false,
      status: 409,
      error: `Session '${agent.id}' has no live pane to send to`,
    };
  }

  const backend = deps.backend;
  return {
    ok: true,
    write: (data) => backend.pty.write(paneId, data),
    interrupt: interruptSequenceFor(
      agent.agentKind,
      typeof body.interrupt === "string" ? body.interrupt : undefined,
    ),
    result: {
      ok: true,
      target: { id: agent.id, paneId, lastAgentStatus: agent.lastAgentStatus },
    },
  };
}

export const agentRoutes: Route[] = [
  {
    method: "GET",
    path: "/agents",
    async handler({ deps, url, json }) {
      if (!deps.agentManager) {
        json(200, []);
        return;
      }

      const projectId = url.searchParams.get("projectId") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit =
        Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
      const offsetParam = parseInt(url.searchParams.get("offset") ?? "", 10);
      const offset =
        Number.isFinite(offsetParam) && offsetParam >= 0
          ? offsetParam
          : undefined;

      // No filters at all: default to just the active sessions, which is what
      // "see every session" means in practice — completed/errored/abandoned
      // agents are noise unless explicitly asked for.
      const noFilters =
        projectId === undefined &&
        status === undefined &&
        limit === undefined &&
        offset === undefined;

      const agents = noFilters
        ? deps.agentManager.getActiveAgents()
        : deps.agentManager.getAllAgents({ projectId, status, limit, offset });

      json(200, agents.map(toSummary));
    },
  },

  {
    // Launch an agent pane in a workspace.
    method: "POST",
    path: "/agents",
    async handler({ json, readBody }) {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      if (typeof workspacePath !== "string") {
        json(400, { error: "Missing 'workspacePath' string in request body" });
        return;
      }
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      const result = startAgent(workspacePath, prompt);
      json(result.ok ? 200 : 503, result);
    },
  },

  {
    // Steer a running agent: gracefully interrupt its current turn, then inject
    // a new prompt. Interrupt-then-inject is deliberate — the interrupt ends the
    // turn without killing the process, and may discard in-flight work, so the
    // pre-interrupt `lastAgentStatus` is returned for the caller to judge.
    method: "POST",
    path: "/sessions/send",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const text = body.text;
      if (typeof text !== "string" || text.length === 0) {
        json(400, { error: "Missing 'text' string in request body" });
        return;
      }

      const ready = prepareWrite(deps, body);
      if (!ready.ok) {
        json(ready.status, { error: ready.error });
        return;
      }

      // Ordering is load-bearing: interrupt to end the current turn, then submit
      // the new prompt. No artificial delay — the pty layer can't guarantee one.
      ready.write(ready.interrupt);
      ready.write(text + "\r");

      json(200, ready.result);
    },
  },

  {
    // Stop a running agent without saying anything to it.
    //
    // `/sessions/send` already interrupts, because injecting a prompt mid-turn
    // requires ending that turn first — but it *requires* text, so until now
    // there was no way to simply make an agent stop. That is the one thing you
    // most want when you are not at the machine and a session has gone wrong,
    // which is why it is its own route rather than a special case of send: a
    // distinct action, distinctly authorised, distinctly audited.
    method: "POST",
    path: "/sessions/interrupt",
    async handler({ deps, json, readBody }) {
      const ready = prepareWrite(deps, await readBody());
      if (!ready.ok) {
        json(ready.status, { error: ready.error });
        return;
      }

      ready.write(ready.interrupt);
      json(200, ready.result);
    },
  },

  {
    // Read-only twin of `/sessions/send`: return another session's rendered
    // output. Snapshot first (live, rendered, already-collapsed redraws),
    // falling back to on-disk scrollback for sessions whose live emulator
    // has already gone away.
    method: "POST",
    path: "/sessions/read",
    async handler({ deps, json, readBody }) {
      const body = await readBody();

      if (!deps.agentManager) {
        json(503, { error: "Agent management is not available" });
        return;
      }
      if (!deps.backend) {
        json(503, { error: "Session backend is not available" });
        return;
      }

      const target = body.target;
      if (typeof target !== "string" || target.length === 0) {
        json(400, { error: "Missing 'target' string in request body" });
        return;
      }

      // An agent handle is the *preferred* target, but not the only one: plain
      // terminal panes never get an AgentInfo, and their scrollback is just as
      // readable — paneId is the pty sessionId is the scrollback dir key. So an
      // unresolved target falls through to being treated as a raw pane id.
      const agent = resolveTarget(deps.agentManager, target);
      if (agent && !agent.paneId) {
        json(409, {
          error: `Session '${agent.id}' has no live pane to read from`,
        });
        return;
      }
      const paneId = agent?.paneId ?? target;

      const snap = await deps.backend.pty.getSnapshot(paneId);
      let ansi: string;
      let source: "live" | "scrollback";
      if (snap) {
        ansi = snap.screenAnsi;
        source = "live";
      } else {
        ansi = ScrollbackWriter.readScrollback(paneId);
        // Without an agent row there is nothing else vouching for this target, so
        // an empty disk read means the pane simply doesn't exist — 404 rather
        // than hand back a convincing-looking empty transcript.
        if (
          !agent &&
          ansi === "" &&
          ScrollbackWriter.readMeta(paneId) === null
        ) {
          json(404, {
            error: `No session or pane matches target '${target}'`,
          });
          return;
        }
        source = "scrollback";
      }

      const raw = body.raw === true;
      let output = raw ? ansi : stripAnsi(ansi);

      const tailLinesParam = body.tailLines;
      const tailLines =
        typeof tailLinesParam === "number" &&
        Number.isFinite(tailLinesParam) &&
        tailLinesParam > 0
          ? Math.floor(tailLinesParam)
          : 200;

      const lines = output.split(/\r?\n/);
      let truncated = false;
      if (lines.length > tailLines) {
        output = lines.slice(lines.length - tailLines).join("\n");
        truncated = true;
      }

      const maxBytesParam = body.maxBytes;
      const maxBytes =
        typeof maxBytesParam === "number" &&
        Number.isFinite(maxBytesParam) &&
        maxBytesParam > 0
          ? Math.floor(maxBytesParam)
          : undefined;
      if (maxBytes !== undefined) {
        const buf = Buffer.from(output, "utf-8");
        if (buf.length > maxBytes) {
          const keepFrom = buf.length - maxBytes;
          let start = keepFrom;
          while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
            start++;
          }
          output = buf.subarray(start).toString("utf-8");
          truncated = true;
        }
      }

      const lineCount = output.length === 0 ? 0 : output.split(/\r?\n/).length;

      json(200, {
        ok: true,
        target: {
          id: agent?.id ?? paneId,
          paneId,
          lastAgentStatus: agent?.lastAgentStatus ?? null,
          kind: agent ? "session" : "pane",
        },
        source,
        text: output,
        lineCount,
        truncated,
      });
    },
  },
];
