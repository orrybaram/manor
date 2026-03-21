import { LinearIntegrationSection } from "./LinearIntegrationSection";
import styles from "./SettingsModal.module.css";

export function IntegrationsPage() {
  return (
    <div className={styles.pageContent}>
      <LinearIntegrationSection />
    </div>
  );
}
