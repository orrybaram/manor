import { createContext } from "react";

/** How a task card reaches the chat's task view. */
export type TaskViewControl = {
  /** Open the view on this task. */
  open: (id: string) => void;
  /** The task the view is showing, or null. */
  viewedId: string | null;
};

/**
 * The chat's task view, for its task cards. Null inside a task's own
 * transcript, whose cards have no transcript the mirror can find.
 */
export const TaskViewContext = createContext<TaskViewControl | null>(null);
