import { useState, type Ref } from "react";
import {
  BellRing,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Info,
  X,
} from "lucide-react";
import { toast as toastApi, type ToastRecord } from "../../../toast";
import styles from "./Toast.module.css";

type ToastItemProps = {
  toast: ToastRecord;
  /** The card's content box, which the deck measures to stack cards by height. */
  measureRef?: Ref<HTMLDivElement>;
};

/** Returns true if the detail text is long enough that expanding reveals more. */
function isExpandable(detail: string | undefined): boolean {
  if (!detail) return false;
  return detail.includes("\n") || detail.length > 80;
}

export function ToastItem(props: ToastItemProps) {
  const { toast } = props;

  // `userExpanded` is null until the user toggles. While null, we defer to
  // `toast.autoExpand`, which can transition true after mount (e.g. a loading
  // toast that updates to an error toast with autoExpand: true). Once the
  // user toggles, their choice sticks and overrides further autoExpand
  // changes — so they can collapse a noisy error.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  const expandable = isExpandable(toast.detail);
  const expanded =
    userExpanded === null ? (toast.autoExpand ?? false) : userExpanded;

  function handleBodyClick() {
    if (!expandable) return;
    setUserExpanded(!expanded);
  }

  return (
    <div ref={props.measureRef} className={styles.toast}>
      {toast.status === "loading" && <div className={styles.spinner} />}
      {toast.status === "success" && (
        <span className={`${styles.icon} ${styles.iconSuccess}`}>
          <CircleCheck size={14} aria-hidden />
        </span>
      )}
      {toast.status === "error" && (
        <span className={`${styles.icon} ${styles.iconError}`}>
          <CircleX size={14} aria-hidden />
        </span>
      )}
      {toast.status === "attention" && (
        <span className={`${styles.icon} ${styles.iconAttention}`}>
          <BellRing size={14} aria-hidden />
        </span>
      )}
      {toast.status === "info" && (
        <span className={`${styles.icon} ${styles.iconInfo}`}>
          <Info size={14} aria-hidden />
        </span>
      )}
      <div
        className={`${styles.body} ${expandable ? styles.detailExpandable : ""}`}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? expanded : undefined}
        onClick={handleBodyClick}
        onKeyDown={(e) => {
          if (!expandable) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setUserExpanded(!expanded);
          }
        }}
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
      {toast.secondaryAction && (
        <button
          className={styles.secondaryActionButton}
          onClick={(e) => {
            e.stopPropagation();
            toast.secondaryAction!.onClick();
          }}
          type="button"
        >
          {toast.secondaryAction.label}
        </button>
      )}
      {toast.duration === "sticky" && (
        <button
          className={styles.dismissButton}
          onClick={(e) => {
            e.stopPropagation();
            toast.onClose?.();
            toastApi.dismiss(toast.id);
          }}
          type="button"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
