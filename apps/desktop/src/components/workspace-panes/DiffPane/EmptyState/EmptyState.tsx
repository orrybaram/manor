import styles from "./EmptyState.module.css";

const ART = `⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
⢸
 ⠱⠀⢸⠀ ⣜
⡀⠀⢸⡀⢸⠀⡇⠀⡀
⠱⡤⠤⢽⣿⡿⢥⣜
 ⡔⠑⡯⠻⢻⠑⣄
 ⡇⠀⣼
⠀⠳⠀⠇`;

const EMPTY_MESSAGES = [
  "All quiet in the dark corners",
  "Nothing stirring here",
  "The shadows are still",
  "Dust settles undisturbed",
];

function getTimeSeedMessage() {
  const minutesSinceEpoch = Math.floor(Date.now() / (60 * 60 * 1000));
  return EMPTY_MESSAGES[minutesSinceEpoch % EMPTY_MESSAGES.length];
}

type EmptyStateProps = {
  message: string;
};

export function EmptyState({ message }: EmptyStateProps) {
  const isNoChanges = message === "No changes found";

  return (
    <div className={styles.root}>
      <div className={styles.content}>
        <pre className={styles.art}>{ART}</pre>
        <p>{isNoChanges ? getTimeSeedMessage() : message}...</p>
      </div>
    </div>
  );
}
