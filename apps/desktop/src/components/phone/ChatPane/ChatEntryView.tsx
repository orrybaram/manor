import { memo, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { ChatEntry } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { Button } from "../../ui/Button/Button";
import {
  isOpenPicker,
  sameItem,
  splitPrompt,
  summarizeTools,
  type ChatItem,
  type ToolGroup,
} from "./chat-entries";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatTypewriter } from "./ChatTypewriter";
import { EditCard } from "./EditCard";
import { PlanCard } from "./PlanCard";
import { AnsweredQuestion, QuestionCard } from "./QuestionCard";
import { TaskCard } from "./TaskCard";
import styles from "./ChatPane.module.css";

type ChatEntryViewProps = {
  paneId: string;
  entry: ChatItem;
  /** The id of the one picker the chat may answer, if any. */
  answerableId: string | null;
  /** Arrived while the chat was open, rather than with its history. */
  live: boolean;
  onShowTerminal: () => void;
};

/**
 * One transcript entry, or a run of tool calls, drawn for its kind. Memoized:
 * a push redraws only the item it changed, not the whole history.
 */
export const ChatEntryView = memo(function ChatEntryView(props: ChatEntryViewProps) {
  const { paneId, entry, answerableId, live, onShowTerminal } = props;

  switch (entry.kind) {
    case "user":
      return (
        <div className={styles.userRow}>
          <div className={styles.userBubble} data-testid="chat-user">
            <UserPrompt text={entry.text} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className={styles.assistant} data-testid="chat-assistant">
          {live ? (
            <ChatTypewriter source={entry.text} />
          ) : (
            <ChatMarkdown source={entry.text} />
          )}
        </div>
      );
    case "tool-group":
      return <ToolGroupView group={entry} />;
    case "command":
      return <CommandEntry entry={entry} />;
    case "notice":
      return (
        <div className={styles.notice} data-testid="chat-notice">
          <span
            className={styles.statusDot}
            data-status={entry.status}
            role="img"
            aria-label={STATUS_LABEL[entry.status]}
          />
          <span className={styles.noticeText}>{entry.text}</span>
        </div>
      );
    case "task":
      return <TaskCard paneId={paneId} task={entry} />;
    case "edit":
      return <EditCard paneId={paneId} entry={entry} />;
    case "question":
      return isOpenPicker(entry) ? (
        <QuestionCard
          paneId={paneId}
          entry={entry}
          answerable={answerableId === entry.id}
          onShowTerminal={onShowTerminal}
        />
      ) : (
        <AnsweredQuestion entry={entry} />
      );
    case "plan":
      return (
        <PlanCard
          paneId={paneId}
          entry={entry}
          answerable={answerableId === entry.id}
          onShowTerminal={onShowTerminal}
        />
      );
    default:
      return null;
  }
}, (prev, next) =>
  prev.paneId === next.paneId &&
  prev.answerableId === next.answerableId &&
  prev.live === next.live &&
  prev.onShowTerminal === next.onShowTerminal &&
  sameItem(prev.entry, next.entry),
);

/**
 * A prompt's text, with each pasted block folded to a "Pasted N lines" row
 * that opens to the paste.
 */
function UserPrompt({ text }: { text: string }) {
  const parts = splitPrompt(text);
  if (parts.length === 1 && parts[0].kind === "typed") return <>{text}</>;
  return (
    <div className={styles.userParts}>
      {parts.map((part, i) =>
        part.kind === "typed" ? (
          <div key={i}>{part.text}</div>
        ) : (
          <details key={i} className={styles.pasted} data-testid="chat-pasted">
            <summary className={styles.pastedSummary}>
              Pasted {lineCount(part.text)}
            </summary>
            <div className={styles.pastedText}>{part.text}</div>
          </details>
        ),
      )}
    </div>
  );
}

function lineCount(text: string): string {
  const lines = text.split("\n").length;
  return lines === 1 ? "1 line" : `${lines} lines`;
}

type ToolGroupViewProps = {
  group: ToolGroup;
};

/**
 * A run of tool calls as one quiet line: a sentence summing them up once
 * they're done ("Ran 2 commands (1 failed), read a file"), or the call in
 * progress while one is running. Tapping it lists the calls.
 */
function ToolGroupView(props: ToolGroupViewProps) {
  const { group } = props;

  const [open, setOpen] = useState(false);
  const running = [...group.tools]
    .reverse()
    .find((t) => t.status === "pending");
  const status = running
    ? "pending"
    : group.tools.some((t) => t.status === "error")
      ? "error"
      : "ok";

  return (
    <div
      className={styles.toolGroup}
      data-testid="chat-tool-group"
      data-status={status}
    >
      <Button
        variant="ghost"
        size="sm"
        className={styles.toolGroupLine}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <RunningTool key={running.id} tool={running} />
        ) : (
          <span className={styles.toolGroupSummary}>
            {summarizeTools(group.tools).map((part, i) => (
              <span key={part.text}>
                {i > 0 && ", "}
                {part.text}
                {part.failed > 0 && (
                  <span className={styles.toolGroupFailed}>
                    {" "}
                    ({part.failed} failed)
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
        <ChevronRight
          className={styles.toolGroupChevron}
          size={14}
          aria-hidden
        />
      </Button>
      {open && (
        <div className={styles.toolRows}>
          {group.tools.map((tool) => (
            <ToolEntry key={tool.id} entry={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

type RunningToolProps = {
  tool: Extract<ChatEntry, { kind: "tool" }>;
};

/** The call in progress, with how long it has been running. */
function RunningTool(props: RunningToolProps) {
  const { tool } = props;

  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  });
  const elapsed = Math.floor((now - Date.parse(tool.ts)) / 1000);

  return (
    <>
      <span
        className={styles.statusDot}
        data-status="pending"
        role="img"
        aria-label="running"
      />
      <span className={styles.toolGroupSummary}>{tool.summary}</span>
      {elapsed >= 0 && <span className={styles.toolElapsed}>{elapsed}s</span>}
    </>
  );
}

type ToolEntryProps = {
  entry: Extract<ChatEntry, { kind: "tool" }>;
};

const STATUS_LABEL = {
  pending: "running",
  ok: "done",
  error: "failed",
} as const;

/** One call inside an open group, expanding to its detail on tap. */
function ToolEntry(props: ToolEntryProps) {
  const { entry } = props;

  const [open, setOpen] = useState(false);
  const expandable = Boolean(entry.detail);

  return (
    <div
      className={styles.tool}
      data-testid="chat-tool"
      data-status={entry.status}
    >
      <Button
        variant="ghost"
        size="sm"
        className={styles.toolLine}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={styles.statusDot}
          data-status={entry.status}
          role="img"
          aria-label={STATUS_LABEL[entry.status]}
        />
        <span className={styles.toolName}>{entry.name}</span>
        <span className={styles.toolSummary}>{entry.summary}</span>
      </Button>
      {open && entry.detail && (
        <pre className={styles.toolDetail}>{entry.detail}</pre>
      )}
    </div>
  );
}

type CommandEntryProps = {
  entry: Extract<ChatEntry, { kind: "command" }>;
};

/**
 * A slash command, or a `!` shell command, as a small chip; expands to its
 * output when it has any.
 */
function CommandEntry(props: CommandEntryProps) {
  const { entry } = props;

  const [open, setOpen] = useState(false);

  const label = (
    <>
      <span className={styles.commandName}>
        {entry.shell ? `! ${entry.name}` : `/${entry.name}`}
      </span>
      {entry.args && <span className={styles.commandArgs}>{entry.args}</span>}
    </>
  );

  return (
    <div className={styles.commandRow} data-testid="chat-command">
      {entry.output ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.commandChip}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
        </Button>
      ) : (
        <div className={styles.commandChip}>{label}</div>
      )}
      {open && entry.output && (
        <pre className={styles.commandOutput}>{entry.output}</pre>
      )}
    </div>
  );
}
