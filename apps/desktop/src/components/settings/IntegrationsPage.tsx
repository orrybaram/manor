import { GitHubIntegrationSection } from "./GitHubIntegrationSection";
import { LinearIntegrationSection } from "./LinearIntegrationSection";
import { Stack } from "../ui/Layout/Layout";
import styles from "./SettingsModal/SettingsModal.module.css";

export function IntegrationsPage() {
  return (
    <Stack className={styles.pageContent}>
      <GitHubIntegrationSection />
      <LinearIntegrationSection />
    </Stack>
  );
}
