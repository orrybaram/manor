import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import CornerDownLeft from "lucide-react/dist/esm/icons/corner-down-left";
import type { ReactNode } from "react";
import type { ChatKey } from "../../../electron.d";
import { Button } from "../../ui/Button/Button";
import styles from "./PaneView.module.css";

const KEYS: readonly { key: ChatKey; label: string; content: ReactNode }[] = [
  { key: "up", label: "Up", content: <ArrowUp size={18} /> },
  { key: "down", label: "Down", content: <ArrowDown size={18} /> },
  { key: "enter", label: "Enter", content: <CornerDownLeft size={18} /> },
  { key: "esc", label: "Escape", content: "Esc" },
  { key: "tab", label: "Tab", content: "Tab" },
];

/**
 * A tap keeps focus where it was. A focused button would blur the terminal
 * and drop the soft keyboard if it was up. The click still fires.
 */
const keepFocus = (e: React.PointerEvent) => e.preventDefault();

type MenuKeyBarProps = {
  paneId: string;
  onBackToChat: () => void;
};

/**
 * The keys a TUI menu needs, which a phone's soft keyboard lacks. Drawn over the bottom of the terminal while the chat has handed it a
 * menu. Each key is one `chat.key`, a fixed navigation keystroke into the
 * pane's PTY. A key that fails to send is dropped: the menu on screen shows
 * whether it moved.
 */
export function MenuKeyBar(props: MenuKeyBarProps) {
  const { paneId, onBackToChat } = props;

  return (
    <div className={styles.keyBar} data-testid="menu-key-bar" role="toolbar" aria-label="Menu keys">
      {KEYS.map(({ key, label, content }) => (
        <Button
          key={key}
          className={styles.key}
          aria-label={label}
          data-testid={`menu-key-${key}`}
          onPointerDown={keepFocus}
          onClick={() => {
            void window.electronAPI.chat.key(paneId, key).catch(() => {});
          }}
        >
          {content}
        </Button>
      ))}
      <Button
        variant="primary"
        className={`${styles.key} ${styles.keyBack}`}
        data-testid="menu-key-back"
        onPointerDown={keepFocus}
        onClick={onBackToChat}
      >
        Back to chat
      </Button>
    </div>
  );
}
