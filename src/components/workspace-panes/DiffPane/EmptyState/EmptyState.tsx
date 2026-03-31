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

type EmptyStateProps = {
  message: string;
};

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className={styles.root}>
      <div className={styles.content}>
        <pre className={styles.art}>{ART}</pre>
        <p>{message}</p>
      </div>
    </div>
  );
}
