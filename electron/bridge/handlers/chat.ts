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
  ChatCommands,
  ChatHistory,
} from "../../chat-mirror/mirror";
import {
  CHAT_KEYS,
  CHAT_SUBMIT,
  type ChatKey,
} from "../../chat-mirror/chat-keys";
import {
  encodeChatMessage,
  type PickerAnswer,
} from "../../chat-mirror/picker-keys";
import { parseChatTaskKey } from "../../chat-mirror/task-key";
import { method, type HandlerCtx } from "../method";

/** The pause between a prompt's text and its Enter. Long enough that Claude
 *  Code reads the Enter as its own keypress, not the tail of a paste. */
const SUBMIT_DELAY_MS = 120;

/**
 * Per-pane serial queue for PTY writes. A prompt is text, a pause, then
 * Enter; a second send, key or interrupt landing in that gap would
 * interleave with it. Each pane's tail promise is dropped once it drains.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(paneId: string, job: () => Promise<void> | void): Promise<void> {
  const prev = writeQueues.get(paneId) ?? Promise.resolve();
  const run = prev.then(job);
  // The tail never rejects, so one failed write doesn't poison the queue.
  const tail = run.catch(() => {});
  writeQueues.set(paneId, tail);
  void tail.then(() => {
    if (writeQueues.get(paneId) === tail) writeQueues.delete(paneId);
  });
  return run;
}

export function chatGetHistory(
  ctx: HandlerCtx,
  paneId: string,
): Promise<ChatHistory> {
  assertString(paneId, "paneId");
  return ctx.deps.chatMirror.getHistory(paneId);
}

/** A task's own transcript (ADR-224 D3); its pushes are `chat.taskEntry`. */
export function chatGetTaskHistory(
  ctx: HandlerCtx,
  paneId: string,
  taskId: string,
): Promise<ChatHistory> {
  assertString(paneId, "paneId");
  assertString(taskId, "taskId");
  return ctx.deps.chatMirror.getTaskHistory(paneId, taskId);
}

export function chatGetCommands(
  ctx: HandlerCtx,
  paneId: string,
): Promise<ChatCommands> {
  assertString(paneId, "paneId");
  return ctx.deps.chatMirror.getCommands(paneId);
}

/** Type a prompt and submit it, as one prompt even across lines (`encodeChatMessage`). */
export async function chatSend(ctx: HandlerCtx, paneId: string, text: string): Promise<void> {
  assertString(paneId, "paneId");
  assertString(text, "text");
  if (text.trim().length === 0) throw new Error("text: expected a message");
  return enqueueWrite(paneId, async () => {
    ctx.deps.backend.pty.write(paneId, encodeChatMessage(text));
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    ctx.deps.backend.pty.write(paneId, CHAT_SUBMIT);
  });
}

/** Esc: what stops Claude mid-turn in its own TUI. */
export function chatInterrupt(ctx: HandlerCtx, paneId: string): Promise<void> {
  assertString(paneId, "paneId");
  return enqueueWrite(paneId, () => ctx.deps.backend.pty.write(paneId, CHAT_KEYS.esc));
}

/** One navigation key into the pane, for driving a TUI menu from the phone (ADR-218 D3). */
export function chatKey(ctx: HandlerCtx, paneId: string, key: ChatKey): Promise<void> {
  assertString(paneId, "paneId");
  assertString(key, "key");
  if (!Object.prototype.hasOwnProperty.call(CHAT_KEYS, key)) {
    throw new Error(`key: expected one of ${Object.keys(CHAT_KEYS).join(", ")}`);
  }
  return enqueueWrite(paneId, () => ctx.deps.backend.pty.write(paneId, CHAT_KEYS[key]));
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
 *   watcher on and off, and for `chat.taskEntry` a task's (ADR-224 D3).
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
    if (name === "chat.entry") {
      chatMirror.setWatched(key, bridge.hasSubscriber("chat", "entry", key));
    } else if (name === "chat.taskEntry") {
      const task = parseChatTaskKey(key);
      if (!task) return;
      chatMirror.setTaskWatched(
        task.paneId,
        task.taskId,
        bridge.hasSubscriber("chat", "taskEntry", key),
      );
    }
  });
  return () => {
    offAgents();
    offSubscriptions();
  };
}

export const chat = {
  // A read; its pushes are `chat.entry`.
  getHistory: method(chatGetHistory),
  // A read; its pushes are `chat.taskEntry`.
  getTaskHistory: method(chatGetTaskHistory),
  getCommands: method(chatGetCommands),
  // The keyboard, like `pty.write`: a line per message or keystroke is a
  // keylogger (ADR-161), so none of these is audited.
  send: method(chatSend),
  interrupt: method(chatInterrupt),
  key: method(chatKey),
  answer: method(chatAnswer),
};
