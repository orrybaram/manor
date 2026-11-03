import styles from "./ChatPane.module.css";

type GableMarkProps = {
  /** Breathes while the agent works; still on a finished turn's line. */
  breathing?: boolean;
};

/** Manor's mark in the chat: a gable roof over a door. */
export function GableMark(props: GableMarkProps) {
  const { breathing = false } = props;

  return (
    <svg
      className={styles.gable}
      data-breathing={breathing || undefined}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 7 7 2.5 12 7v5H2Z" />
      <path d="M5.6 12V9h2.8v3" />
    </svg>
  );
}
