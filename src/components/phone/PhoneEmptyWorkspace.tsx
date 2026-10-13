import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import { useState } from "react";
import { hostServerUnavailableCopy, useConnection } from "../../bridge/connection";
import { getAgentKindForCommand } from "../../agent-defaults";
import { launchAgentInWorkspace } from "../../lib/agent-prompt-launch";
import { resolveWorkspaceCommand } from "../../lib/keybinding-commands";
import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { Button } from "../ui/Button/Button";
import { EmojiTextarea } from "../ui/EmojiAutocomplete";
import { ManorLogo } from "../ui/ManorLogo";
import chatStyles from "./ChatPane/ChatPane.module.css";
import { markChatStarting } from "./ChatPane/usePaneChatView";
import styles from "./PhoneEmptyWorkspace.module.css";

/**
 * A workspace with no tabs, on a phone: a chat that hasn't started yet.
 *
 * The desk's empty state is a list of keyboard shortcuts, which a phone has
 * no use for. Here the first message is the new agent's prompt: nothing is
 * launched until it is sent, so closing the last agent lands back on this
 * screen rather than spawning another one.
 */
export function PhoneEmptyWorkspace() {
  const [text, setText] = useState("");

  // A host server does not launch agents (ADR-218 D5): say so instead of
  // offering a composer whose first message goes nowhere.
  const { isHostServer, hostName } = useConnection();
  const canSend = !isHostServer && text.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    const { activeWorkspacePath, activeWorkspaceHostId } = useAppStore.getState();
    if (!activeWorkspacePath) return;
    const command = resolveWorkspaceCommand(selectActiveWorkspaceKey(useAppStore.getState()));
    const opened = launchAgentInWorkspace(activeWorkspacePath, {
      prompt: text.trimEnd(),
      hostId: activeWorkspaceHostId,
    });
    if (opened && getAgentKindForCommand(command) === "claude") {
      markChatStarting(opened.paneId);
    }
  };

  return (
    <div className={styles.root} data-testid="phone-empty-workspace">
      <div className={styles.body}>
        <div className={styles.logo}>
          <ManorLogo />
        </div>
      </div>
      {isHostServer && (
        <div className={styles.unavailable} data-testid="phone-empty-unavailable">
          {hostServerUnavailableCopy("Starting new agents", hostName)}
        </div>
      )}
      <div className={chatStyles.composer} data-keyboard-lift>
        <div className={chatStyles.composerField}>
          <EmojiTextarea
            className={chatStyles.composerInput}
            value={text}
            rows={1}
            disabled={isHostServer}
            placeholder="Ask Claude…"
            aria-label="First message for a new agent"
            data-testid="phone-empty-composer-input"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // As in the chat: ⌘/Ctrl+Enter sends, a plain Enter is a new line.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button
            variant="primary"
            className={chatStyles.composerButton}
            aria-label="Start agent"
            disabled={!canSend}
            onClick={send}
            data-testid="phone-empty-send"
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </div>
  );
}
