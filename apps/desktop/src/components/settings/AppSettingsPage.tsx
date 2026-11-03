import { ThemeSection } from "./ThemeSection";
import { FontSection } from "./FontSection/FontSection";
import { Stack } from "../ui/Layout/Layout";
import styles from "./SettingsModal/SettingsModal.module.css";

export function AppSettingsPage() {
  return (
    <Stack className={styles.pageContent}>
      <ThemeSection />

      <FontSection />
    </Stack>
  );
}
