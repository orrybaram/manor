import { ThemeSection } from "./ThemeSection";
import { Stack } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

export function AppSettingsPage() {
  return (
    <Stack className={styles.pageContent}>
      <ThemeSection />

      <Stack gap="xs">
        <SectionTitle id="app-font">Font</SectionTitle>
        <div className={styles.placeholder}>
          Font family and size settings coming soon.
        </div>
      </Stack>
    </Stack>
  );
}
