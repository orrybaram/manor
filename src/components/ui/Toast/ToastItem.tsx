import { useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useToastStore, type Toast as ToastData } from "../../../store/toast-store";
import styles from "./Toast.module.css";

export const AUTO_DISMISS_MS = 3000;

type ToastItemProps = {
  toast: ToastData;
};

/** Returns true if the detail text is long enough that expanding reveals more. */
function isExpandable(detail: string | undefined): boolean {
  if (!detail) return false;
  return detail.includes("\n") || detail.length > 80;
}

export function ToastItem(props: ToastItemProps) {
  const { toast } = props;

  const removeToast = useToastStore((s) => s.removeToast);
  const [exiting, setExiting] = useState(false);
  // `userExpanded` is null until the user toggles. While null, we defer to
  // `toast.autoExpand`, which can transition true after mount (e.g. a loading
  // toast that updates to an error toast with autoExpand: true). Once the
  // user toggles, their choice sticks and overrides further autoExpand
  // changes — so they can collapse a noisy error.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expandable = isExpandable(toast.detail);
  const expanded =
    userExpanded === null ? (toast.autoExpand ?? false) : userExpanded;

  useMountEffect(() => {
    if (toast.status === "loading") return;
    if (toast.persistent) return;

    const delay =
      toast.duration ??
      (toast.status === "error" ? AUTO_DISMISS_MS * 2 : AUTO_DISMISS_MS);
    dismissRef.current = setTimeout(() => {
      setExiting(true);
      exitRef.current = setTimeout(() => removeToast(toast.id), 200);
    }, delay);

    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
      if (exitRef.current) clearTimeout(exitRef.current);
    };
  });

  function handleBodyClick() {
    if (!expandable) return;
    setUserExpanded(!expanded);
  }

  return (
    <div className={`${styles.toast} ${exiting ? styles.exiting : ""}`}>
      {toast.status === "loading" && <div className={styles.spinner} />}
      {toast.status === "success" && (
        <span className={`${styles.icon} ${styles.iconSuccess}`}>&#10003;</span>
      )}
      {toast.status === "error" && (
        <span className={`${styles.icon} ${styles.iconError}`}>&#10007;</span>
      )}
      <div
        className={`${styles.body} ${expandable ? styles.detailExpandable : ""}`}
        onClick={handleBodyClick}
      >
        <div className={styles.message}>{toast.message}</div>
        {toast.detail && (
          <div
            className={
              expanded ? styles.detailExpanded : styles.detailCollapsed
            }
          >
            {toast.detail}
          </div>
        )}
        {expandable && (
          <div className={styles.chevron}>
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </div>
        )}
      </div>
      {toast.action && (
        <button
          className={styles.actionButton}
          onClick={(e) => {
            e.stopPropagation();
            toast.action!.onClick();
          }}
          type="button"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
