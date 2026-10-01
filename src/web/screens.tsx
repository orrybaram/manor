import type { ReactNode, JSX } from "react";

/**
 * The web app's dead-end screens (ADR-178 D1), split out of `web-main.tsx`.
 *
 * `web-main.tsx` is the entry module — it runs top-level `await`s and installs
 * the bridge as a side effect of being imported — and a component defined
 * alongside that trips `react-refresh/only-export-components` (the plugin
 * wants a module that exports either components or non-components, not a mix
 * with side-effecting entry code). These three have no state and no reason to
 * live anywhere else, so they get their own module instead of a suppression
 * comment.
 */

/** One message, centred, on nothing. Every dead end here renders as one. */
function FullPageMessage(props: {
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={props.testId}
      style={{
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
