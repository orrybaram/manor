import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import { useMemo, useState } from "react";
import { getAgentKindForCommand } from "../../agent-defaults";
import type { AgentInfo } from "../../electron.d";
import { useAgentDisplay } from "../../hooks/useAgentDisplay";
import { launchAgentInWorkspace } from "../../lib/agent-prompt-launch";
import { resumeAgent } from "../../lib/agent-resume";
import { greeting } from "../../lib/greeting";
import { resolveWorkspaceCommand } from "../../lib/keybinding-commands";
import { find } from "../../lib/workspace-directory";
import { workspaceDisplayName } from "../../lib/workspace-display-name";
import { useAgentStore } from "../../store/agent-store";
import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { relativeShortThenDate } from "../../utils/relative-time";
import { Button } from "../ui/Button/Button";
import { EmojiTextarea } from "../ui/EmojiAutocomplete";
import { ManorLogo } from "../ui/ManorLogo";
import chatStyles from "./ChatPane/ChatPane.module.css";
import { markChatStarting } from "./ChatPane/usePaneChatView";
import { recentStatus, recentWorkspaceAgents } from "./phone-empty-state";
import styles from "./PhoneEmptyWorkspace.module.css";
import { useViewerFirstName } from "./useViewerFirstName";

/**
 * A workspace with no tabs, on a phone: a chat that hasn't started yet.
 *
 * The desk's empty state is a list of keyboard shortcuts, which a phone has
 * no use for. Here the first message is the new agent's prompt: nothing is
 * launched until it is sent, so closing the last agent lands back on this
 * screen rather than spawning another one. Above the composer, the
 * workspace's past agents sit in a rail to jump back into.
 */
export function PhoneEmptyWorkspace() {
  const [text, setText] = useState("");

  const canSend = text.trim().length > 0;

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
        <div className={styles.mark}>
          <div className={styles.glow} aria-hidden="true" />
          <div className={styles.logo}>
            <ManorLogo />
          </div>
        </div>
        <Greeting />
      </div>
      <RecentAgents />
      <div className={chatStyles.composer} data-keyboard-lift>
        <div className={chatStyles.composerField}>
          <EmojiTextarea
            className={chatStyles.composerInput}
            value={text}
            rows={1}
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

/** "Good evening" and where the new agent will run. */
function Greeting() {
  const key = useAppStore(selectActiveWorkspaceKey);
  const name = useProjectStore((s) => workspaceDisplayName(key, s.projects));
  const branch = useProjectStore((s) => (key ? find(s.projects, key)?.workspace.branch : undefined));
  // Read once per mount: the screen is short-lived, and a greeting that
  // flips mid-read is worse than one an hour stale.
  const [hello] = useState(() => greeting(Date.now()));
  const firstName = useViewerFirstName();

  return (
    <div className={styles.greeting}>
      <h1 className={styles.headline}>
        {firstName ? `${hello}, ${firstName}` : hello}
      </h1>
      <p className={styles.subline}>
        Claude is ready in <span className={styles.workspaceName}>{name}</span>
        {branch && branch !== name ? (
          <>
            {" "}on <span className={styles.branch}>{branch}</span>
          </>
        ) : null}
        . What's on your mind?
      </p>
    </div>
  );
}

/** The workspace's past agents, newest first, as a sideways-scrolling rail. */
function RecentAgents() {
  const workspacePath = useAppStore((s) => s.activeWorkspacePath);
  const hostId = useAppStore((s) => s.activeWorkspaceHostId);
  const agents = useAgentStore((s) => s.agents);
  const recents = useMemo(
    () => recentWorkspaceAgents(agents, workspacePath, hostId),
    [agents, workspacePath, hostId],
  );

  if (recents.length === 0) return null;

  return (
    <section className={styles.recents} aria-labelledby="phone-recents-heading">
      <h2 id="phone-recents-heading" className={styles.recentsHeading}>
        Jump back in
      </h2>
      <div className={styles.rail} data-testid="phone-recent-agents">
        {recents.map((agent) => (
          <RecentAgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

function RecentAgentCard(props: { agent: AgentInfo }) {
  const { agent } = props;
  const { title } = useAgentDisplay(agent);
  const { label, tone } = recentStatus(agent);
  const when = relativeShortThenDate(Date.parse(agent.updatedAt));

  return (
    <Button
      variant="ghost"
      className={styles.card}
      data-tone={tone}
      onClick={() => resumeAgent(agent)}
      data-testid="phone-recent-agent"
    >
      <span className={styles.cardTitle}>{title}</span>
      <span className={styles.cardStatus}>
        <span className={styles.cardDot} aria-hidden="true" />
        {label} · {when}
      </span>
    </Button>
  );
}
