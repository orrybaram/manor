import styles from "./SpinnerLoader.module.css";

interface SpinnerLoaderProps {
  size: "pane" | "tab" | "sidebar" | "debug";
}

export function SpinnerLoader({ size }: SpinnerLoaderProps) {
  return (
    <span
      className={`${styles.spinner} ${styles[size]}`}
      title="Agent working"
    />
  );
}
