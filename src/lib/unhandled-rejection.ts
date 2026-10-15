import { addErrorToast, wasReported } from "../store/toast-store";

/**
 * Toast every promise rejection nothing handled (ADR-232 D2), so a failure
 * in a fire-and-forget call reaches the user instead of only the console.
 * One that `addErrorToast` already showed — a store action that toasts and
 * rethrows — is not shown twice, and a cancelled request is not a failure.
 * Returns the uninstall.
 */
export function installUnhandledRejectionToasts(): () => void {
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    if (wasReported(reason)) {
      event.preventDefault();
      return;
    }
    if (reason instanceof Error && reason.name === "AbortError") return;
    event.preventDefault();
    console.error("Unhandled rejection:", reason);
    addErrorToast("unhandled-rejection", "Something went wrong", reason);
  };
  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}
