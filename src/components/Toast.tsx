import { useToastStore } from "../store/toast-store";
import { ToastItem } from "./ToastItem";
import styles from "./Toast.module.css";

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((t) => (
        <ToastItem key={`${t.id}-${t.status}`} toast={t} />
      ))}
    </div>
  );
}
