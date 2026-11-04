import { useRef } from "react";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { ChatPaneMenu } from "./ChatPaneMenu";
import { ChatThinking } from "./ChatThinking";
import styles from "./ChatPane.module.css";
import { UserBubble } from "./UserBubble";
import { useStartingPrompt } from "./usePaneChatView";

type ChatStartingProps = {
  paneId: string;
  /** The workspace the pane is in, for its right-click menu. */
  workspaceKey?: WorkspaceKey;
  /** The pane's **Agent kind**, if known yet. Only Claude's chat starts
   *  ahead of its transcript (a launch from the phone, or `/clear`), so one
   *  not known yet is Claude's. */
  agentKind: string | null;
  /** The terminal is showing instead. */
  hidden: boolean;
  layout?: LayoutMode;
};

/**
 * Holds a new agent pane's chat until its transcript is known.
 * The session's Agent, and with it the transcript, only exists once the
 * first prompt is sent, so this offers the composer: that prompt goes to the
 * pty like any other, and the real `ChatPane` takes over from there. A prompt
 * sent from here, or that the agent was launched with, shows while it starts.
 */
export function ChatStarting(props: ChatStartingProps) {
  const { paneId, workspaceKey, agentKind, hidden, layout = "phone" } = props;
  const prompt = useStartingPrompt(paneId);
  const composerRef = useRef<ChatComposerHandle>(null);
  return (
    <ChatPaneMenu
      paneId={paneId}
      workspaceKey={workspaceKey}
      layout={layout}
      onPaste={() => composerRef.current?.paste()}
    >
      <div
        className={`${styles.chatPane} ${hidden ? styles.hidden : ""}`}
        data-chat-pane
        data-layout={layout}
        data-testid="chat-starting"
        aria-hidden={hidden || undefined}
      >
        <div className={styles.scroller}>
          <div className={styles.entries}>
            {prompt === null ? (
              <p className={styles.empty}>New conversation. Send a message to start.</p>
            ) : (
              <>
                <UserBubble text={prompt} />
                <ChatThinking />
              </>
            )}
          </div>
        </div>
        <ChatComposer ref={composerRef} paneId={paneId} agentKind={agentKind ?? "claude"} busy={false} layout={layout} />
      </div>
    </ChatPaneMenu>
  );
}
