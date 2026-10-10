import { ToggleGroup } from "../../ui/ToggleGroup";
import type { ChatView } from "./chat-view";
import styles from "./ChatViewToggle.module.css";

const OPTIONS: { value: ChatView; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "terminal", label: "Terminal" },
];

type ChatViewToggleProps = {
  value: ChatView;
  onChange: (view: ChatView) => void;
};

/**
 * The strip above a phone's Claude pane that switches between the chat and
 * the terminal. It is laid out in both views, so switching moves nothing.
 */
export function ChatViewToggle(props: ChatViewToggleProps) {
  const { value, onChange } = props;

  return (
    <div className={styles.strip} data-testid="chat-view-toggle">
      <ToggleGroup
        value={value}
        onChange={onChange}
        options={OPTIONS}
        size="sm"
        aria-label="Pane view"
      />
    </div>
  );
}
