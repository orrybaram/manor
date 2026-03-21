import { useCallback } from "react";
import { ExternalLink } from "lucide-react";
import styles from "./Sidebar.module.css";

export function PortBadge({ port }: { port: import("../electron.d.ts").ActivePort }) {
  const handleOpen = useCallback(() => {
    window.electronAPI.shell.openExternal(`http://localhost:${port.port}`);
  }, [port.port]);

  return (
    <div
      className={styles.portBadge}
      title={`Open localhost:${port.port}`}
      onClick={handleOpen}
      style={{ cursor: "pointer" }}
    >
      <span className={styles.portNumber}>{port.port}</span>
      <span className={styles.portProcess}>{port.processName}</span>
      <ExternalLink size={12} className={styles.portOpen} />
    </div>
  );
}
