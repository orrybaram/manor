import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
import { groupEntries, TASK_LABEL, type TaskItem } from "./chat-entries";
import { ChatEntryView } from "./ChatEntryView";
import { TaskStatusDot } from "./TaskStatusDot";
import { useTaskChatView } from "./useTaskChatView";
import styles from "./ChatPane.module.css";

type TaskSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paneId: string;
  task: TaskItem;
};

const NOOP = () => {};

/**
 * A task's own transcript in a bottom sheet (ADR-224 D4): the same entries
 * the chat draws, read-only. No composer, and no picker in it can be answered
 * from here.
 */
export function TaskSheet(props: TaskSheetProps) {
  const { open, onOpenChange, paneId, task } = props;

  return (
    <PhoneSheet
      open={open}
      onOpenChange={onOpenChange}
      variant="bottom"
      hiddenTitle={task.title}
      data-testid="chat-task-sheet"
    >
      <div className={styles.taskSheetHeader}>
        <TaskStatusDot status={task.display} />
        <span className={styles.taskSheetTitle}>{task.title}</span>
        {task.agentType && <span className={styles.taskChip}>{task.agentType}</span>}
        <span className={styles.taskSheetStatus}>{TASK_LABEL[task.display]}</span>
        <PhoneSheetClose label="Close task" />
      </div>
      {/* Mounted only while open, so a closed card watches nothing. */}
      {open && <TaskTranscript paneId={paneId} taskId={task.id} />}
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
                onShowTerminal={NOOP}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
