import styles from "./SpinnerLoader.module.css";

interface SpinnerLoaderProps {
  size: "pane" | "tab" | "sidebar" | "debug";
  variant?: "working" | "thinking";
}

export function SpinnerLoader({
  size,
  variant = "working",
}: SpinnerLoaderProps) {
  return (
    <span
      className={`${styles.spinner} ${styles[size]} ${styles[variant]}`}
      title={variant === "thinking" ? "Agent thinking" : "Agent working"}
    />
  );
}
