import { useCallback, useState } from "react";
import { readChatView, writeChatView, type ChatView } from "./chat-view";

/**
 * A pane's Chat | Terminal choice (ADR-215 D7): read once from this
 * browser's storage, chat by default, and written back on every change.
 */
export function usePaneChatView(paneId: string): [ChatView, (view: ChatView) => void] {
  const [view, setViewState] = useState<ChatView>(() => readChatView(paneId));
  const setView = useCallback(
    (next: ChatView) => {
      setViewState(next);
      writeChatView(paneId, next);
    },
    [paneId],
  );
  return [view, setView];
}
