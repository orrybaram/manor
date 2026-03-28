import styles from "./SpinnerLoader.module.css";

type SpinnerLoaderProps = {
  size: "pane" | "tab" | "sidebar" | "debug";
  variant?: "working" | "thinking";
};

export function SpinnerLoader(props: SpinnerLoaderProps) {
  const { size, variant = "working" } = props;

  return (
    <span
      className={`${styles.spinner} ${styles[size]} ${styles[variant]}`}
      title={variant === "thinking" ? "Agent thinking" : "Agent working"}
    />
  );
}
