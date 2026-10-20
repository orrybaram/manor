import {
  Component,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type JSX,
} from "react";
import CloudOff from "lucide-react/dist/esm/icons/cloud-off";
import { listPairings, subscribePairings } from "../bridge/pairings";
import { useServers, type ServerEntry } from "../bridge/server-set";
import { Button } from "../components/ui/Button/Button";
import styles from "./screens.module.css";

/**
 * The web app's dead-end screens, split out of `web-main.tsx`.
 *
 * `web-main.tsx` is the entry module — it runs top-level `await`s and installs
 * the bridge as a side effect of being imported — and a component defined
 * alongside that trips `react-refresh/only-export-components` (the plugin
 * wants a module that exports either components or non-components, not a mix
 * with side-effecting entry code). These have no state of their own and no
 * reason to live anywhere else, so they get their own module instead of a
 * suppression comment.
 */

/** One message, centred, on the theme's background. Every dead end here renders as one. */
function FullPageMessage(props: {
  children: ReactNode;
  testId?: string;
  /** Over whatever is already rendered, rather than in place of it. */
  overlay?: boolean;
  /** Names the dialog when `overlay`: the screen's title element. */
  labelledBy?: string;
}): JSX.Element {
  return (
    <div
      data-testid={props.testId}
      role={props.overlay ? "alertdialog" : undefined}
      aria-modal={props.overlay ? true : undefined}
      aria-labelledby={props.labelledBy}
      className={styles.page}
    >
      <div className={styles.content}>{props.children}</div>
    </div>
  );
}

/** "Open the link from the pairing dialog" — the whole screen, deliberately. */
export function NoTokenScreen(): JSX.Element {
  return (
    <FullPageMessage testId="web-app-no-token">
      <h1 className={styles.title}>This device isn&apos;t paired</h1>
      <p className={styles.body}>
        Open the link from the pairing dialog in Manor &rarr; Settings &rarr;
        Devices.
      </p>
    </FullPageMessage>
  );
}

/**
 * The desktop's relay address was reset: this link's key no longer
 * matches. The stored pairing is kept — this may be a stale tab, and a reload
 * picks up a fresh link if the page was re-opened from one.
 */
export function KeyMismatchScreen(props: { onRetry: () => void }): JSX.Element {
  return (
    <FullPageMessage testId="web-app-key-mismatch" overlay labelledBy="web-app-key-mismatch-title">
      <h1 id="web-app-key-mismatch-title" className={styles.title}>
        This link has expired
      </h1>
      <p className={styles.body}>
        The desktop&apos;s relay address was reset. Scan a new pairing code from
        Manor&apos;s settings.
      </p>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    </FullPageMessage>
  );
}

/** One pairing's state, as the not-reachable screen lists it. */
function pairingState(server: ServerEntry | undefined): {
  label: string;
  state: "connected" | "unreachable" | "connecting" | "refused";
} {
  if (server?.outcome === "unauthorized") return { label: "No longer paired", state: "refused" };
  if (server?.outcome === "key-mismatch") return { label: "Link expired", state: "refused" };
  switch (server?.reachability) {
    case "connected":
      return { label: "Connected", state: "connected" };
    case "unreachable":
      return { label: "Not reachable", state: "unreachable" };
    default:
      return { label: "Connecting…", state: "connecting" };
  }
}

/** Every pairing this browser holds and how its server is doing, live. */
function PairingList(): JSX.Element | null {
  const pairings = useSyncExternalStore(subscribePairings, listPairings, listPairings);
  const entries = useServers();
  if (pairings.length === 0) return null;
  return (
    <ul className={styles.hosts} data-testid="web-app-unreachable-hosts">
      {pairings.map((pairing) => {
        const status = pairingState(entries.find((e) => e.id === pairing.roomId));
        return (
          <li key={pairing.roomId} className={styles.host} data-state={status.state}>
            <span className={styles.dot} data-state={status.state} aria-hidden />
            <span className={styles.hostName}>{pairing.name}</span>
            <span className={styles.hostState}>{status.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The relay has no server to put this browser through to: every
 * pairing said 4404 (the machine is asleep, offline, or relay mode is off),
 * 4429 (too many viewers, or today's budget is spent), or stopped answering.
 * Not a refusal — the credentials are kept and the bridge keeps dialling with
 * backoff — so this covers the app rather than replacing it, and disappears
 * on the next hello without the app below losing its state.
 *
 * A host reached only through a desktop is not listed: with the desktop
 * away it is away too. The Hosts sheet offers to connect to it directly.
 */
export function UnreachableScreen(props: { onRetry: () => void }): JSX.Element {
  return (
    <FullPageMessage testId="web-app-unreachable" overlay labelledBy="web-app-unreachable-title">
      <span className={styles.icon} aria-hidden>
        <CloudOff size={22} />
      </span>
      <h1 id="web-app-unreachable-title" className={styles.title}>
        Can&apos;t reach Manor
      </h1>
      <p className={styles.body}>
        None of your hosts are answering. Check that the computer running Manor
        is awake and that the relay is on in Settings &rarr; Remote control.
      </p>
      <PairingList />
      <div className={styles.retrying} role="status">
        <span className={styles.spinner} aria-hidden />
        Retrying automatically
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={props.onRetry}>
          Try again now
        </Button>
      </div>
    </FullPageMessage>
  );
}

/**
 * How long the page must stay unreachable before the screen covers it. A
 * phone back from the background often finds its sockets dead and redials
 * each within a second or two; a load can see the same. Neither should
 * flash a full-page error.
 */
export const UNREACHABLE_SHOW_AFTER_MS = 3_000;

/** `UnreachableScreen` once the bridge has said so for a moment, and nothing otherwise. */
export function ReachabilityOverlay(props: {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => "unknown" | "connected" | "unreachable";
  onRetry: () => void;
}): JSX.Element | null {
  const status = useSyncExternalStore(props.subscribe, props.getSnapshot);
  // Mounted per spell of unreachability, so each one waits afresh.
  return status === "unreachable" ? <DelayedUnreachable onRetry={props.onRetry} /> : null;
}

function DelayedUnreachable(props: { onRetry: () => void }): JSX.Element | null {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), UNREACHABLE_SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return shown ? <UnreachableScreen onRetry={props.onRetry} /> : null;
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

/**
 * A part of the app that failed to load — on a phone, usually a chunk the
 * network dropped. Without this the page is blank for good; with it, there
 * is a way back that does not mean finding the pairing link again.
 */
export function LoadFailedScreen(): JSX.Element {
  return (
    <FullPageMessage testId="web-app-load-failed">
      <h1 className={styles.title}>Part of Manor didn&apos;t load</h1>
      <p className={styles.body}>The connection may have dropped.</p>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    </FullPageMessage>
  );
}

/** Shows `LoadFailedScreen` in place of a tree that threw while rendering. */
export class LoadFailureBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[web] the app failed to render", error);
  }

  render(): ReactNode {
    return this.state.failed ? <LoadFailedScreen /> : this.props.children;
  }
}
