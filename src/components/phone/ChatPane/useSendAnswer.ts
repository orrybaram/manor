import { useState } from "react";
import type { ChatAnswer } from "../../../electron.d";

/**
 * - `sending`: `chat.answer` is in flight.
 * - `sent`: main typed it; the card waits for the entry to update with the
 *   answer (or with `needsTerminal`, if none arrives in time).
 * - `terminal`: main refused (`stale`, `unsupported`, …) or the call failed.
 *   Nothing was typed, and the user finishes in the terminal.
 */
export type AnswerPhase = "idle" | "sending" | "sent" | "terminal";

/** Send one picker's answer at most once, and track how it went. */
export function useSendAnswer(paneId: string, toolUseId: string) {
  const [phase, setPhase] = useState<AnswerPhase>("idle");

  const send = (answer: ChatAnswer) => {
    if (phase !== "idle") return;
    setPhase("sending");
    window.electronAPI.chat.answer(paneId, toolUseId, answer).then(
      (result) => setPhase(result.ok ? "sent" : "terminal"),
      () => setPhase("terminal"),
    );
  };

  return { phase, send };
}
