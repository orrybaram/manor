import styles from "./SpinnerLoader.module.css";

type SpinnerLoaderProps = {
  size: "pane" | "tab" | "sidebar" | "debug";
  variant?: "working" | "thinking" | "idle";
};

const TITLES = {
  working: "Agent working",
  thinking: "Agent thinking",
  idle: "Agent idle",
} as const;

export function SpinnerLoader(props: SpinnerLoaderProps) {
  const { size, variant = "working" } = props;

  return (
    <span
      className={`${styles.spinner} ${styles[size]} ${styles[variant]}`}
      title={TITLES[variant]}
    />
  );
}
