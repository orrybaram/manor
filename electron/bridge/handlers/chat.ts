/**
 * The phone's chat view of a Claude pane (ADR-215 D4, D5), as the `chat`
 * namespace of the handler table.
 *
 * Reads come from the pane's transcript mirror (`chat-mirror/mirror.ts`);
 * pushes are `chat.entry`, keyed by paneId like `pty.*`, and published by the
 * mirror only while somebody is subscribed (`wireChatMirror`). Writes are
 * keystrokes into the same PTY the terminal view shows: the PTY stays the
 * truth, and either view can be used at any moment.
 */

import type { AgentInfo } from "../../agent-persistence";
import { assertString } from "../../ipc-validate";
import type { HostDeps } from "../../ipc/types";
import { addRendererBroadcastSink } from "../../renderer-broadcast";
import type {
  ChatAnswer,
  ChatAnswerResult,
  ChatHistory,
} from "../../chat-mirror/mirror";
import { encodeChatMessage, type PickerAnswer } from "../../chat-mirror/picker-keys";
import { method, type HandlerCtx } from "../method";

const ESC = "\x1b";

export function chatGetHistory(
  ctx: HandlerCtx,
  paneId: string,
): Promise<ChatHistory> {
  assertString(paneId, "paneId");
  return ctx.deps.chatMirror.getHistory(paneId);
}

/** Type a prompt and submit it, as one prompt even across lines (`encodeChatMessage`). */
export function chatSend(ctx: HandlerCtx, paneId: string, text: string): void {
  assertString(paneId, "paneId");
  assertString(text, "text");
  if (text.trim().length === 0) throw new Error("text: expected a message");
  ctx.deps.backend.pty.write(paneId, encodeChatMessage(text));
}

/** Esc: what stops Claude mid-turn in its own TUI. */
export function chatInterrupt(ctx: HandlerCtx, paneId: string): void {
  assertString(paneId, "paneId");
  ctx.deps.backend.pty.write(paneId, ESC);
}

export function chatAnswer(
  ctx: HandlerCtx,
  paneId: string,
  toolUseId: string,
  answer: ChatAnswer,
): Promise<ChatAnswerResult> {
  assertString(paneId, "paneId");
  assertString(toolUseId, "toolUseId");
  assertChatAnswer(answer);
  return ctx.deps.chatMirror.answer(paneId, toolUseId, answer);
}

function assertPickerAnswer(
  value: unknown,
  name: string,
): asserts value is PickerAnswer {
  if (!value || typeof value !== "object") {
    throw new Error(`${name}: expected an object`);
  }
  const a = value as Record<string, unknown>;
  if (a.kind === "other") {
    assertString(a.text, `${name}.text`);
    return;
  }
  if (a.kind === "option") {
    if (
      !Array.isArray(a.indexes) ||
      !a.indexes.every((i) => typeof i === "number" && Number.isInteger(i))
    ) {
      throw new Error(`${name}.indexes: expected an array of integers`);
    }
    return;
  }
  throw new Error(`${name}.kind: expected "option" or "other"`);
}

function assertChatAnswer(value: unknown): asserts value is ChatAnswer {
  if (!value || typeof value !== "object") {
    throw new Error("answer: expected an object");
  }
  const a = value as Record<string, unknown>;
  if (a.kind === "plan-approve") return;
  if (a.kind !== "question") {
    throw new Error('answer.kind: expected "question" or "plan-approve"');
  }
  if (!Array.isArray(a.answers)) {
    throw new Error("answer.answers: expected an array");
  }
  a.answers.forEach((x, i) => assertPickerAnswer(x, `answer.answers[${i}]`));
}

/**
 * The mirror's two outside signals, wired once at boot.
 *
 * - Every agent update (`agents.updated`, from its single send-site) re-checks
 *   that pane's transcript path: `/clear` and resume switch transcripts, and
 *   the hook that says so updates the agent.
 * - The bridge's subscriber count for `chat.entry` is what turns a pane's
 *   watcher on and off.
 */
export function wireChatMirror(
  deps: Pick<HostDeps, "chatMirror">,
  bridge: {
    onSubscriptionChange(cb: (name: string, key: string) => void): () => void;
    hasSubscriber(ns: string, event: string, key: string): boolean;
  },
): () => void {
  const { chatMirror } = deps;
  const offAgents = addRendererBroadcastSink((broadcast) => {
    if (broadcast.ns !== "agents" || broadcast.event !== "updated") return;
    const agent = broadcast.args[0] as AgentInfo | undefined;
    if (agent?.paneId) chatMirror.agentChanged(agent.paneId);
  });
  const offSubscriptions = bridge.onSubscriptionChange((name, key) => {
    if (name !== "chat.entry") return;
    chatMirror.setWatched(key, bridge.hasSubscriber("chat", "entry", key));
  });
  return () => {
    offAgents();
    offSubscriptions();
  };
}

export const chat = {
  // A read; its pushes are `chat.entry`.
  getHistory: method(chatGetHistory),
  // The keyboard, like `pty.write`: a line per message or keystroke is a
  // keylogger (ADR-161), so none of these is audited.
  send: method(chatSend),
  interrupt: method(chatInterrupt),
  answer: method(chatAnswer),
};
