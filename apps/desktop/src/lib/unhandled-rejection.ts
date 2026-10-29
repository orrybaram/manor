import { toast, wasReported } from "../toast";

/**
 * Toast every promise rejection nothing handled, so a failure
 * in a fire-and-forget call reaches the user instead of only the console.
 * One that `toast.error` already showed — a store action that toasts and
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
    toast.error("Something went wrong", { id: "unhandled-rejection", error: reason });
  };
  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}
