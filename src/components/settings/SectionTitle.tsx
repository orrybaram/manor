import type { ReactNode } from "react";
import styles from "./SettingsModal/SettingsModal.module.css";

type SectionTitleProps = {
  /** Anchor id used by settings search to scroll this section into view. */
  id: string;
  children: ReactNode;
};

/** Heading for a settings section, doubling as a search navigation target. */
export function SectionTitle(props: SectionTitleProps) {
  const { id, children } = props;
  return (
    <div className={styles.sectionTitle} data-settings-section={id}>
      {children}
    </div>
  );
}
