import { useEffect, useState, type SyntheticEvent } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { terminalFor } from "../../lib/terminal-registry";
import { selectFocusedPaneOfActiveTab, useAppStore } from "../../store/app-store";
import { Button } from "../ui/Button/Button";
import styles from "./TerminalKeyBar.module.css";

/**
 * The keys a phone's keyboard does not have, above it while it is up for a
 * terminal: Esc to interrupt an agent, ⇧Tab to cycle its mode, the arrows
 * for its menus, Tab, ^C and ^D.
 *
 * Only while a soft keyboard is actually up. Without one the bar would sit
 * over the terminal's bottom rows — where a TUI keeps its prompt — and a
 * hardware keyboard has these keys already.
 *
 * Fixed to the bottom of the *visual* viewport, which is the top of the soft
 * keyboard, and laid out over the terminal rather than beside it: the phone
 * shell is sized to the large viewport so the keyboard never resizes a pane
 * (`Phone.module.css`), and a bar that took layout space would undo that.
 *
 * A key goes in through `term.input`, the same door a typed key takes, so it
 * reaches whoever owns the pane exactly like typing does. A tap never takes
 * focus from xterm's textarea — that would close the keyboard.
 */

type Key = { label: string; aria: string; data: (appCursor: boolean) => string };

const arrow = (final: string) => (appCursor: boolean) =>
  appCursor ? `\x1bO${final}` : `\x1b[${final}`;

const KEYS: Key[] = [
  { label: "esc", aria: "Escape", data: () => "\x1b" },
  { label: "tab", aria: "Tab", data: () => "\t" },
  { label: "⇧tab", aria: "Shift Tab", data: () => "\x1b[Z" },
  { label: "^C", aria: "Control C", data: () => "\x03" },
  { label: "^D", aria: "Control D", data: () => "\x04" },
  { label: "←", aria: "Left", data: arrow("D") },
  { label: "↓", aria: "Down", data: arrow("B") },
  { label: "↑", aria: "Up", data: arrow("A") },
  { label: "→", aria: "Right", data: arrow("C") },
];

function terminalHasFocus(): boolean {
  return document.activeElement?.classList.contains("xterm-helper-textarea") ?? false;
}

/** Less than this between the layout and visual viewports is not a keyboard
 *  (a collapsing URL bar is ~60px). */
const KEYBOARD_MIN_PX = 80;

/** Where the bar's bottom edge goes: the bottom of the visual viewport. */
function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
}

export function TerminalKeyBar() {
  const paneId = useAppStore(selectFocusedPaneOfActiveTab);
  const [focused, setFocused] = useState(terminalHasFocus);
  const [inset, setInset] = useState(keyboardInset);

  useMountEffect(() => {
    const onFocus = () => setFocused(terminalHasFocus());
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
    };
  });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !focused) return;
    const onViewport = () => setInset(keyboardInset());
    onViewport();
    vv.addEventListener("resize", onViewport);
    vv.addEventListener("scroll", onViewport);
    return () => {
      vv.removeEventListener("resize", onViewport);
      vv.removeEventListener("scroll", onViewport);
    };
  }, [focused]);

  if (!focused || !paneId || inset < KEYBOARD_MIN_PX) return null;

  const send = (key: Key) => {
    const term = terminalFor(paneId);
    if (!term) return;
    term.input(key.data(term.modes.applicationCursorKeysMode), true);
  };
  // Keep xterm's textarea focused, and with it the keyboard.
  const keepFocus = (e: SyntheticEvent) => e.preventDefault();

  return (
    <div
      className={styles.bar}
      style={{ bottom: inset }}
      role="toolbar"
      aria-label="Terminal keys"
      data-testid="terminal-key-bar"
    >
      {KEYS.map((key) => (
        <Button
          key={key.label}
          variant="ghost"
          className={styles.key}
          aria-label={key.aria}
          tabIndex={-1}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => send(key)}
        >
          {key.label}
        </Button>
      ))}
    </div>
  );
}
