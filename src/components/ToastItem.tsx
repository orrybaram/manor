import { useRef, useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useToastStore, type Toast as ToastData } from "../store/toast-store";
import styles from "./Toast.module.css";

export const AUTO_DISMISS_MS = 3000;

export function ToastItem({ toast }: { toast: ToastData }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const [exiting, setExiting] = useState(false);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMountEffect(() => {
    if (toast.status === "loading") return;

    const delay =
      toast.status === "error" ? AUTO_DISMISS_MS * 2 : AUTO_DISMISS_MS;
    dismissRef.current = setTimeout(() => {
      setExiting(true);
      exitRef.current = setTimeout(() => removeToast(toast.id), 200);
    }, delay);

    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
      if (exitRef.current) clearTimeout(exitRef.current);
    };
  });

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
