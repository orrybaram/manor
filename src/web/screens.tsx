import { useSyncExternalStore, type ReactNode, type JSX } from "react";
import { Button } from "../components/ui/Button/Button";

/**
 * The web app's dead-end screens (ADR-178 D1), split out of `web-main.tsx`.
 *
 * `web-main.tsx` is the entry module — it runs top-level `await`s and installs
 * the bridge as a side effect of being imported — and a component defined
 * alongside that trips `react-refresh/only-export-components` (the plugin
 * wants a module that exports either components or non-components, not a mix
 * with side-effecting entry code). These have no state of their own and no
 * reason to live anywhere else, so they get their own module instead of a
 * suppression comment.
 */

/** One message, centred, on nothing. Every dead end here renders as one. */
function FullPageMessage(props: {
  children: ReactNode;
  testId?: string;
  /** Over whatever is already rendered, rather than in place of it. */
  overlay?: boolean;
}): JSX.Element {
  return (
    <div
      data-testid={props.testId}
      role={props.overlay ? "alertdialog" : undefined}
      style={{
        ...(props.overlay && {
          position: "fixed",
          inset: 0,
          zIndex: 10_000,
          flexDirection: "column",
          gap: "1rem",
        }),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        color: "#ccc",
        background: "#1e1e2e",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      {props.children}
    </div>
  );
}

/** "Open the link from the pairing dialog" — the whole screen, deliberately. */
export function NoTokenScreen(): JSX.Element {
  return (
    <FullPageMessage testId="web-app-no-token">
      This device isn&apos;t paired. Open the link from the pairing dialog in
      Manor &rarr; Settings &rarr; Remote control.
    </FullPageMessage>
  );
}

/**
 * Paired, but below `full` (ADR-178 D3). The token is good — it is a `read`
 * or `send` device, and those tiers are an allowlist of routes, not this
 * surface. Said plainly, and without forgetting the token: the same device
 * still works in the remote client at `/`.
 */
export function ForbiddenScreen(): JSX.Element {
  return (
    <FullPageMessage testId="web-app-forbidden">
      This device isn&apos;t paired with full access, so it can&apos;t open the
      full Manor app. Re-pair it at full access in Manor &rarr; Settings &rarr;
      Remote control, or use the lightweight client at{" "}
      <code style={{ marginLeft: "0.25rem" }}>/</code>.
    </FullPageMessage>
  );
}

/**
 * The desktop's relay address was reset (ADR-206): this link's key no longer
 * matches. The stored pairing is kept — this may be a stale tab, and a reload
 * picks up a fresh link if the page was re-opened from one.
 */
export function KeyMismatchScreen(props: { onRetry: () => void }): JSX.Element {
  return (
    <FullPageMessage testId="web-app-key-mismatch" overlay>
      <div>
        This link&apos;s relay address has changed &mdash; the desktop&apos;s
        relay address was reset. Scan a new pairing code from Manor&apos;s
        settings.
      </div>
      <Button variant="secondary" onClick={props.onRetry}>
        Try again
      </Button>
    </FullPageMessage>
  );
}

/**
 * The relay has no desktop to put this browser through to (ADR-206 D3): the
 * relay said 4404 (the machine is asleep, offline, or relay mode is off) or
 * 4429 (too many viewers, or today's budget is spent). Not a refusal — the
 * credentials are kept and the bridge keeps dialling with backoff — so this
 * covers the app rather than replacing it, and disappears on the next hello
 * without the app below losing its state.
 */
export function UnreachableScreen(props: { onRetry: () => void }): JSX.Element {
  return (
    <FullPageMessage testId="web-app-unreachable" overlay>
      <div>
        Manor is not reachable right now. Check that the computer running Manor
        is awake and that the relay is turned on in Settings &rarr; Remote
        control. Retrying&hellip;
      </div>
      <Button variant="secondary" onClick={props.onRetry}>
        Try again now
      </Button>
    </FullPageMessage>
  );
}

/** `UnreachableScreen` while the bridge says so, and nothing otherwise. */
export function ReachabilityOverlay(props: {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => "unknown" | "connected" | "unreachable";
  onRetry: () => void;
}): JSX.Element | null {
  const status = useSyncExternalStore(props.subscribe, props.getSnapshot);
  return status === "unreachable" ? (
    <UnreachableScreen onRetry={props.onRetry} />
  ) : null;
}

/**
 * While `App`'s chunk loads: the same splash `web.html` paints before any
 * script runs, so the first render replaces it with itself rather than with
 * a blank page.
 */
export function BootScreen(): JSX.Element {
  return (
    <div className="boot" role="status">
      <div className="boot-mark" />
      Connecting to Manor…
    </div>
  );
}
