import { useEffect, useRef, useState } from "react";
import { useToastStore, type Toast as ToastData } from "../store/toast-store";
import styles from "./Toast.module.css";

const AUTO_DISMISS_MS = 3000;

function ToastItem({ toast }: { toast: ToastData }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const [exiting, setExiting] = useState(false);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (toast.status === "loading") return;

    dismissRef.current = setTimeout(() => {
      setExiting(true);
      exitRef.current = setTimeout(() => removeToast(toast.id), 200);
    }, AUTO_DISMISS_MS);

    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
      if (exitRef.current) clearTimeout(exitRef.current);
    };
  }, [toast.status, toast.id, removeToast]);

  return (
    <div className={`${styles.toast} ${exiting ? styles.exiting : ""}`}>
      {toast.status === "loading" && <div className={styles.spinner} />}
      {toast.status === "success" && (
        <span className={`${styles.icon} ${styles.iconSuccess}`}>&#10003;</span>
      )}
      {toast.status === "error" && (
        <span className={`${styles.icon} ${styles.iconError}`}>&#10007;</span>
      )}
      <div className={styles.body}>
        <div className={styles.message}>{toast.message}</div>
        {toast.detail && <div className={styles.detail}>{toast.detail}</div>}
      </div>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
