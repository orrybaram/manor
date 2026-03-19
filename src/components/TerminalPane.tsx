import { useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useThemeStore } from "../store/theme-store";
import { useTerminalLifecycle } from "../hooks/useTerminalLifecycle";
import styles from "./TerminalPane.module.css";

interface TerminalPaneProps {
  paneId: string;
  cwd?: string;
}

export function TerminalPane({ paneId, cwd }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  useTerminalLifecycle(containerRef, paneId, cwd, theme);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    />
  );
}
