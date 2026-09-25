/**
 * Typed hook events.
 *
 * Wire-faithful discriminated union — one variant per HTTP event the agent
 * CLIs emit. The parser is the single seam between URL-param wire shape and
 * in-process types: it validates required fields, gates Notification by
 * notificationKind, and stamps each variant with its derived AgentStatus.
 *
 * Downstream consumers (relay, AgentDetector seam) read `event.status`
 * directly; nothing else needs to know how `eventType` maps to status.
 */

import type { AgentKind } from "./terminal-host/types";
import { getAllAgentKinds } from "./agent-connectors";

interface EventBase {
  paneId: string;
  sessionId: string | null;
  agentKind: AgentKind;
}

export type AgentHookEvent =
  | (EventBase & { type: "SessionStart"; status: "thinking" })
  | (EventBase & { type: "SessionEnd"; status: "idle" })
  | (EventBase & { type: "UserPromptSubmit"; status: "thinking" })
  | (EventBase & { type: "PreToolUse"; status: "working" })
  | (EventBase & { type: "PostToolUse"; status: "thinking" })
  | (EventBase & { type: "PostToolUseFailure"; status: "thinking" })
  | (EventBase & { type: "Stop"; status: "responded" })
  | (EventBase & { type: "StopFailure"; status: "error" })
  | (EventBase & { type: "PermissionRequest"; status: "requires_input" })
  | (EventBase & { type: "Notification"; status: "requires_input" })
  | (EventBase & {
      type: "SubagentStart";
      status: "working";
      toolUseId: string | null;
    })
  | (EventBase & {
      type: "SubagentStop";
      status: "thinking";
      toolUseId: string | null;
    });

export type AgentHookEventType = AgentHookEvent["type"];

export type ParseResult =
  | { ok: true; event: AgentHookEvent }
  | { ok: false; action: "drop" | "reject"; reason: string };

/**
 * Parse URL params from the hook HTTP endpoint into a typed event.
 *
 * Returns:
 * - `{ ok: true, event }` for a valid, known-kind, mapped event type. The
 *   HTTP handler should respond 200 and forward.
 * - `{ ok: false, action: "drop", reason }` for events that should not be
 *   relayed but are not protocol errors (filtered Notification kinds,
 *   unknown eventType strings). HTTP handler responds 200.
 * - `{ ok: false, action: "reject", reason }` for protocol errors
 *   (missing paneId/eventType, unknown agent kind). HTTP handler responds 400.
 *
 * `knownKinds` defaults to `new Set(getAllAgentKinds())`. Tests can inject
 * a fixed set to avoid coupling to the connector registry.
 */
export function parseAgentHookEvent(
  params: URLSearchParams,
  knownKinds: ReadonlySet<string> = new Set(getAllAgentKinds()),
): ParseResult {
  const paneId = params.get("paneId");
  const rawType = params.get("eventType");
  const sessionId = params.get("sessionId");
  const rawKind = params.get("kind");
  const toolUseId = params.get("toolUseId");
  const notificationKind = params.get("notificationKind");

  if (!paneId || !rawType) {
    return {
      ok: false,
      action: "reject",
      reason: "missing paneId or eventType",
    };
  }

  if (!rawKind || !knownKinds.has(rawKind)) {
    return {
      ok: false,
      action: "reject",
      reason: `unknown agent kind: ${rawKind ?? "(missing)"}`,
    };
  }
  const agentKind = rawKind as AgentKind;

  // Notification gating: only permission-style notifications relay.
  // Legacy (notificationKind absent → null) is treated as permission-style
  // for backwards compat with Claude Code versions that don't send the field.
  if (
    rawType === "Notification" &&
    notificationKind !== null &&
    notificationKind !== "permission_prompt"
  ) {
    return {
      ok: false,
      action: "drop",
      reason: `non-permission Notification: notificationKind=${notificationKind}`,
    };
  }

  const base: EventBase = { paneId, sessionId, agentKind };

  switch (rawType) {
    case "SessionStart":
      return { ok: true, event: { ...base, type: "SessionStart", status: "thinking" } };
    case "SessionEnd":
      return { ok: true, event: { ...base, type: "SessionEnd", status: "idle" } };
    case "UserPromptSubmit":
      return { ok: true, event: { ...base, type: "UserPromptSubmit", status: "thinking" } };
    case "PreToolUse":
      return { ok: true, event: { ...base, type: "PreToolUse", status: "working" } };
    case "PostToolUse":
      return { ok: true, event: { ...base, type: "PostToolUse", status: "thinking" } };
    case "PostToolUseFailure":
      return { ok: true, event: { ...base, type: "PostToolUseFailure", status: "thinking" } };
    case "Stop":
      return { ok: true, event: { ...base, type: "Stop", status: "responded" } };
    case "StopFailure":
      return { ok: true, event: { ...base, type: "StopFailure", status: "error" } };
    case "PermissionRequest":
      return { ok: true, event: { ...base, type: "PermissionRequest", status: "requires_input" } };
    case "Notification":
      return { ok: true, event: { ...base, type: "Notification", status: "requires_input" } };
    case "SubagentStart":
      return {
        ok: true,
        event: { ...base, type: "SubagentStart", status: "working", toolUseId },
      };
    case "SubagentStop":
      return {
        ok: true,
        event: { ...base, type: "SubagentStop", status: "thinking", toolUseId },
      };
    default:
      return {
        ok: false,
        action: "drop",
        reason: `unmapped eventType: ${rawType}`,
      };
  }
}

/** The one path the hook script requests (see electron/scripts/agent-hook.js). */
export const HOOK_EVENT_PATH = "/hook/event";

/**
 * The query parameters of a hook request, or null when the request is not
 * for `HOOK_EVENT_PATH` (the listener answers 404).
 */
export function hookRequestParams(rawUrl: string | undefined): URLSearchParams | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
  return url.pathname === HOOK_EVENT_PATH ? url.searchParams : null;
}

/**
 * What a hook HTTP listener should do with a request. Shared by the local
 * `AgentHookServer` and the remote daemon's hook listener (ADR-178 §2), so
 * both accept exactly the same requests:
 *
 * - `status: 404` — no URL, or not `/hook/event`.
 * - `status: 400` — a protocol error (`parseAgentHookEvent` rejected it).
 * - `status: 200` with no `payload` — well-formed but not relayed (e.g. a
 *   non-permission Notification); answer `ok` and drop it.
 * - `status: 200` with `payload` — relay it. `payload` is the request's
 *   query parameters, the form a remote daemon journals.
 */
export type HookRequestVerdict =
  | { status: 404 }
  | { status: 400; reason: string }
  | { status: 200; reason: string; payload?: undefined }
  | { status: 200; payload: Record<string, string>; event: AgentHookEvent };

export function classifyHookRequest(
  rawUrl: string | undefined,
  knownKinds?: ReadonlySet<string>,
): HookRequestVerdict {
  const params = hookRequestParams(rawUrl);
  if (!params) return { status: 404 };
  const result = parseAgentHookEvent(params, knownKinds);
  if (!result.ok) {
    return result.action === "reject"
      ? { status: 400, reason: result.reason }
      : { status: 200, reason: result.reason };
  }
  return {
    status: 200,
    payload: Object.fromEntries(params),
    event: result.event,
  };
}
