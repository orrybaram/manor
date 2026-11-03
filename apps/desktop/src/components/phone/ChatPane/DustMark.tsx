import styles from "./ChatPane.module.css";

type DustMarkProps = {
  /** Motes rise and fade while the agent works; still on a finished turn's line. */
  live?: boolean;
};

/** Manor's mark in the chat: three motes of dust. */
export function DustMark(props: DustMarkProps) {
  const { live = false } = props;

  return (
    <svg
      className={styles.dust}
      data-live={live || undefined}
      viewBox="0 0 14 14"
      fill="currentColor"
      aria-hidden
    >
      <circle className={styles.mote} cx="3.2" cy="9" r="1.15" />
      <circle className={styles.mote} cx="7.4" cy="7" r="1.15" />
      <circle className={styles.mote} cx="11" cy="9.6" r="1.15" />
    </svg>
  );
}
