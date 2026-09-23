/**
 * `/agents` — live session state, read-only. This is the "see every session"
 * surface `list_agents` (`electron/mcp/tools-sessions.ts`) proxies: every
 * `AgentInfo` the `AgentManager` (`../agent-persistence.ts`) knows about,
 * regardless of which project or workspace it belongs to.
 *
 * Entirely main-served — `agentManager` already lives in the main process, so
 * unlike the viewport routes there is no renderer round-trip here. `POST
 * /agents` joined them: it opens the tab through `LayoutStore` and queues the
 * launch line beside it, so an agent can be started with no window open
 * (ADR-179 ticket 11).
 */

import type { AgentInfo, AgentManager } from "../agent-persistence";
import { getConnector } from "../agent-connectors";
import { agentCommandWithPrompt } from "../../src/lib/agent-command";
import { resolveAgentCommand } from "../../src/lib/resolve-agent-command";
import { createTab } from "../../src/lib/layout/ids";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import type { LayoutOrigin } from "../layout/layout-store";
import { interruptSequenceFor } from "../harness-interrupt";
import { sendAgentUpdate } from "../notifications";
import {
  agentsDelete,
  agentsMarkSeen,
  agentsUpdate,
} from "../bridge/handlers/agents";
import { localCtx } from "../bridge/method";
import { stripAnsi } from "../terminal-host/output-pattern-matcher";
import { ScrollbackWriter } from "../terminal-host/scrollback";
import type { HostDeps, Route } from "./types";

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
export function resolveTarget(
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
 * other step is shared, so it happens here once: the target resolves to a
 * session, that session still has a live pane, and this
 * harness's interrupt sequence is known.
 *
 * `write` is bound to the pane. `result` is the 200 body, built
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
  deps: HostDeps,
  body: Record<string, unknown>,
): PreparedWrite {
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

  return {
    ok: true,
    write: (data) => deps.backend.pty.write(paneId, data),
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

type ResolvedAgent =
  | { ok: false; status: number; error: string }
  | { ok: true; agent: AgentInfo };

/**
 * Shared preamble for the `/agents/:agentId/*` management routes: `:agentId`
 * resolves the same forgiving way
 * `/sessions/read` resolves `target` (`resolveTarget`, above) — an agent id,
 * or a raw paneId — so a caller holding either handle can reach the same
 * agent. Not found is the caller's mistake (404).
 */
function resolveAgentParam(deps: HostDeps, agentId: string): ResolvedAgent {
  const agent = resolveTarget(deps.agentManager, agentId);
  if (!agent) {
    return { ok: false, status: 404, error: `No agent matches '${agentId}'` };
  }
  return { ok: true, agent };
}


/** What a caller gets back once an agent's tab exists. */
export interface StartedAgent {
  tabId: string;
  paneId: string;
  workspacePath: string;
}

export type StartAgentResult =
  | { ok: true; data: StartedAgent }
  | { ok: false; status: number; error: string };

const AGENT_ORIGIN: LayoutOrigin = { kind: "route", id: "agents" };

/**
 * Open an agent tab in `workspacePath` and queue its launch line — entirely on
 * the server (ADR-179 ticket 11).
 *
 * This used to be a correlated round-trip to a window (`start-agent` in
 * `src/lib/app-commands.ts`), for one reason: the launch line had to be seeded
 * into the *sending renderer's* pending-command map, which only that
 * renderer's pane mount effect read back. Now the map is the server's, so both
 * halves of a launch — the tab and the line typed into it — happen here, and
 * `manor start-agent` works with the desktop window closed like every other
 * structural command.
 *
 * Everything ADR-176 asked for still holds, and holds more simply: the target
 * is explicit (`workspacePath`, never "whatever is active"), the prompt is
 * flattened before it is quoted, and the answer names the pane that was
 * actually created, so a caller can retry a launch that did not happen. What
 * is deliberately *not* reproduced is the renderer's sidebar selection: which
 * workspace a window is looking at is that window's viewport (D3), and a route
 * does not move it.
 */
export async function startAgentInWorkspace(
  deps: HostDeps,
  workspacePath: string,
  options: { prompt?: string; agentCommand?: string } = {},
): Promise<StartAgentResult> {
  const store = deps.layoutStore;
  // The renderer's `getAgentCommand` asks the same question of its stores.
  const base = resolveAgentCommand({
    override: options.agentCommand,
    workspacePath,
    homePrefs: deps.preferencesManager.getAll(),
    projects: await deps.projectManager.getProjects(),
  });
  const tab = createTab();
  const paneId = allPaneIds(tab.rootNode)[0];

  // Queued before the tab exists, for the ordering `pendingCommands` spells
  // out: the apply broadcasts, a renderer mounts the pane, and its
  // `pty.create` is what types this.
  store.pendingCommands.set(
    paneId,
    agentCommandWithPrompt(base, options.prompt),
    "agent-startup",
  );

  const result = await store.apply(
    workspacePath,
    { type: "new-tab", tab, select: true },
    AGENT_ORIGIN,
  );
  if ("error" in result) {
    store.pendingCommands.clear(paneId);
    return { ok: false, status: 400, error: result.error };
  }
  return { ok: true, data: { tabId: tab.id, paneId, workspacePath } };
}

export const agentRoutes: Route[] = [
  {
    method: "GET",
    path: "/agents",
    async handler({ deps, url, json }) {
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
    // Launch an agent pane in a workspace, server-side (ADR-179 ticket 11).
    // The answer is the outcome, not a dispatch: the `StartedAgent` names the
    // pane that now exists, so a caller can tell a launch that happened from
    // one that did not and retry it (ADR-176).
    method: "POST",
    path: "/agents",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      if (typeof workspacePath !== "string") {
        json(400, { error: "Missing 'workspacePath' string in request body" });
        return;
      }
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      const agentCommand =
        typeof body.agentCommand === "string" ? body.agentCommand : undefined;
      const result = await startAgentInWorkspace(deps, workspacePath, {
        prompt,
        agentCommand,
      });
      if (!result.ok) {
        json(result.status, { error: result.error });
        return;
      }
      json(200, result.data);
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
    // Destructive: end a session outright by killing its pty process, not
    // just its current turn. `/sessions/interrupt` leaves the process alive
    // and idle; this does not — there is nothing left to resume, and any
    // in-flight work is lost. Distinct from `DELETE /agents/:agentId`, which
    // only forgets Manor's record of a session (dead or alive) and never
    // touches the process: ending marks the record 'abandoned' so it still
    // reflects reality, deleting removes the record entirely.
    method: "POST",
    path: "/sessions/end",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const target = body.target;
      if (typeof target !== "string" || target.length === 0) {
        json(400, { error: "Missing 'target' string in request body" });
        return;
      }

      const agent = resolveTarget(deps.agentManager, target);
      if (!agent) {
        json(404, { error: `No session matches target '${target}'` });
        return;
      }
      const { paneId } = agent;
      if (!paneId) {
        json(409, { error: `Session '${agent.id}' has no live pane to end` });
        return;
      }

      await deps.backend.pty.kill(paneId);

      // Mirrors `createAgentService` (`../bridge/handlers/agents.ts`): only an
      // *active* session's record moves to 'abandoned' — a session that had
      // already completed or errored keeps that outcome.
      if (agent.status === "active") {
        const updated = deps.agentManager.updateAgent(agent.id, {
          status: "abandoned",
          completedAt: new Date().toISOString(),
        });
        if (updated) sendAgentUpdate(updated, deps.preferencesManager);
      }

      json(200, { ok: true, target: { id: agent.id, paneId } });
    },
  },

  {
    // Read-only twin of `/sessions/send`: return another session's rendered
    // output. Snapshot first (live, rendered, already-collapsed redraws),
    // falling back to on-disk scrollback for sessions whose live emulator
    // has already gone away.
    //
    // `cols`/`rows` ride along because a *renderer* needs the grid's width,
    // not just its text: an agent's box borders, diff gutters and progress
    // lines are drawn assuming column alignment, and the longest line in a
    // tail is not the column count — a client can't recover the grid from
    // the text alone. Live comes from the snapshot, cold from scrollback's
    // `meta.json`; if neither has it, both are `null` rather than a guessed
    // 80, so a client that gets `null` knows it's guessing too.
    method: "POST",
    path: "/sessions/read",
    async handler({ deps, json, readBody }) {
      const body = await readBody();

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
      let cols: number | null;
      let rows: number | null;
      if (snap) {
        ansi = snap.screenAnsi;
        source = "live";
        cols = snap.cols ?? null;
        rows = snap.rows ?? null;
      } else {
        ansi = ScrollbackWriter.readScrollback(paneId);
        const meta = ScrollbackWriter.readMeta(paneId);
        // Without an agent row there is nothing else vouching for this target, so
        // an empty disk read means the pane simply doesn't exist — 404 rather
        // than hand back a convincing-looking empty transcript.
        if (!agent && ansi === "" && meta === null) {
          json(404, {
            error: `No session or pane matches target '${target}'`,
          });
          return;
        }
        source = "scrollback";
        cols = meta?.cols ?? null;
        rows = meta?.rows ?? null;
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
        cols,
        rows,
      });
    },
  },

  {
    // `agents.update` (`../bridge/handlers/agents.ts`), the handler the
    // renderer's `renameAgent` invokes: a non-empty `name` pins it, an empty
    // one un-pins and clears it. `renameAgent` also restores the live pty
    // title on clear — renderer-only state (`paneAgentStatus`) this route has
    // no path to, so a clear here lands as `null` and waits for the next
    // status change to resync, same as any other pinned-name clear main
    // doesn't hear about immediately.
    method: "POST",
    path: "/agents/:agentId/rename",
    async handler({ deps, params, json, readBody }) {
      const resolved = resolveAgentParam(deps, params.agentId);
      if (!resolved.ok) {
        json(resolved.status, { error: resolved.error });
        return;
      }

      const body = await readBody();
      const name = body.name;
      if (typeof name !== "string") {
        json(400, { error: "Missing 'name' string in request body" });
        return;
      }

      const trimmed = name.trim();
      const updates = trimmed
        ? { name: trimmed, namePinned: true }
        : { name: null, namePinned: false };

      const updated = agentsUpdate(localCtx(deps), resolved.agent.id, updates);
      if (!updated) {
        json(404, { error: `No agent matches '${params.agentId}'` });
        return;
      }
      json(200, toSummary(updated));
    },
  },

  {
    // Destructive: permanently removes the agent record (not the workspace or
    // its files — just Manor's memory of the session). `agents.delete`
    // (`../bridge/handlers/agents.ts`) itself, so the unseen-flag sets are
    // cleared and the dock badge recomputed exactly as a renderer's delete
    // does — a deleted agent can't keep the badge lit.
    method: "DELETE",
    path: "/agents/:agentId",
    async handler({ deps, params, json }) {
      const resolved = resolveAgentParam(deps, params.agentId);
      if (!resolved.ok) {
        json(resolved.status, { error: resolved.error });
        return;
      }

      const ok = agentsDelete(localCtx(deps), resolved.agent.id);
      json(200, { ok });
    },
  },

  {
    // `agents.markSeen` (`../bridge/handlers/agents.ts`) itself: clears both
    // unseen sets for this agent, marks its notification-log entries read, and
    // re-broadcasts so the renderer's cache drops the pulse without a reload.
    method: "POST",
    path: "/agents/:agentId/seen",
    async handler({ deps, params, json }) {
      const resolved = resolveAgentParam(deps, params.agentId);
      if (!resolved.ok) {
        json(resolved.status, { error: resolved.error });
        return;
      }

      agentsMarkSeen(localCtx(deps), resolved.agent.id);
      json(200, { ok: true });
    },
  },

  {
    // Mirrors `agents.buildResumeCommand` (`../bridge/handlers/agents.ts`):
    // the shell command that would resume this agent's session in its
    // harness, or `409` if the agent never recorded one (e.g. it was never
    // launched from a resumable command).
    method: "GET",
    path: "/agents/:agentId/resume-command",
    async handler({ deps, params, json }) {
      const resolved = resolveAgentParam(deps, params.agentId);
      if (!resolved.ok) {
        json(resolved.status, { error: resolved.error });
        return;
      }

      const { agent } = resolved;
      if (!agent.agentCommand) {
        json(409, {
          error: `Agent '${agent.id}' has no agentCommand to resume`,
        });
        return;
      }

      const command = getConnector(agent.agentKind).getResumeCommand(
        agent.agentCommand,
        agent.agentSessionId,
      );
      json(200, { command });
    },
  },
];
