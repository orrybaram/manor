import type { ChatEntry } from "../../../electron.d";
import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
import { groupEntries, TASK_DOT, TASK_LABEL, type TaskDisplayStatus } from "./chat-entries";
import { ChatEntryView } from "./ChatEntryView";
import { useTaskChatView } from "./useTaskChatView";
import styles from "./ChatPane.module.css";

type TaskEntry = Extract<ChatEntry, { kind: "task" }>;

type TaskSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paneId: string;
  entry: TaskEntry;
  status: TaskDisplayStatus;
};

const NOOP = () => {};

/**
 * A task's own transcript in a bottom sheet (ADR-224 D4): the same entries
 * the chat draws, read-only. No composer, and no picker in it can be answered
 * from here.
 */
export function TaskSheet(props: TaskSheetProps) {
  const { open, onOpenChange, paneId, entry, status } = props;

  return (
    <PhoneSheet
      open={open}
      onOpenChange={onOpenChange}
      variant="bottom"
      hiddenTitle={entry.title}
      data-testid="chat-task-sheet"
    >
      <div className={styles.taskSheetHeader}>
        <span
          className={styles.statusDot}
          data-status={TASK_DOT[status]}
          role="img"
          aria-label={TASK_LABEL[status]}
        />
        <span className={styles.taskSheetTitle}>{entry.title}</span>
        {entry.agentType && <span className={styles.taskChip}>{entry.agentType}</span>}
        <span className={styles.taskSheetStatus}>{TASK_LABEL[status]}</span>
        <PhoneSheetClose label="Close task" />
      </div>
      {/* Mounted only while open, so a closed card watches nothing. */}
      {open && <TaskTranscript paneId={paneId} taskId={entry.id} />}
    </PhoneSheet>
  );
}

function TaskTranscript(props: { paneId: string; taskId: string }) {
  const { paneId, taskId } = props;

  const { entries, loaded, unavailable } = useTaskChatView(paneId, taskId);
  const items = groupEntries(entries);

  return (
    <div className={styles.taskSheetBody}>
      {items.length === 0 ? (
        <p className={styles.empty}>{loaded || unavailable ? "No transcript yet" : ""}</p>
      ) : (
        <div className={styles.entries}>
          {items.map((item) => (
            <div key={item.id} className={styles.entry}>
              <ChatEntryView
                paneId={paneId}
                entry={item}
                answerableId={null}
                live={false}
                stale={false}
                onShowTerminal={NOOP}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
