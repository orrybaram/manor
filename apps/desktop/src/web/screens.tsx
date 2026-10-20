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
      // Opts out of the phone's dialog clamp (`Phone.module.css`).
      data-full-page
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
 * on the next hello without the app below losing its state. Only for a page
 * that never connected: a later drop is `ReconnectingPill`.
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
 * How long the page must stay unreachable before it says so. A phone back
 * from the background often finds its sockets dead and redials each within
 * a second or two; that should not flash anything.
 */
export const UNREACHABLE_SHOW_AFTER_MS = 3_000;

/**
 * The same, before the page has ever connected. A cold start often hears the
 * relay's "no host" once or twice while the desktop's own relay socket comes
 * back, then connects on the next redial; until then it is loading, not
 * broken.
 */
export const FIRST_CONNECT_SHOW_AFTER_MS = 10_000;

/**
 * Over the app until the page first connects: a skeleton of the phone shell,
 * then `UnreachableScreen` if that takes too long. After that, a drop is a
 * small "Reconnecting" pill once the bridge has said "unreachable" for a
 * moment, so a chat mid-read stays on screen.
 */
export function ReachabilityOverlay(props: {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => "unknown" | "connected" | "unreachable";
  onRetry: () => void;
}): JSX.Element | null {
  const status = useSyncExternalStore(props.subscribe, props.getSnapshot);
  const [everConnected, setEverConnected] = useState(false);
  if (status === "connected" && !everConnected) setEverConnected(true);

  if (status === "connected") return null;
  if (!everConnected) {
    // Mounted on the first "unreachable", so the wait counts from there.
    return status === "unreachable" ? (
      <DelayedUnreachable
        delayMs={FIRST_CONNECT_SHOW_AFTER_MS}
        pending={<ConnectingSkeleton />}
        onRetry={props.onRetry}
      />
    ) : (
      <ConnectingSkeleton />
    );
  }
  // Mounted per spell of unreachability, so each one waits afresh.
  return status === "unreachable" ? (
    <Delayed delayMs={UNREACHABLE_SHOW_AFTER_MS} pending={null}>
      <ReconnectingPill onRetry={props.onRetry} />
    </Delayed>
  ) : null;
}

function DelayedUnreachable(props: {
  delayMs: number;
  pending: JSX.Element | null;
  onRetry: () => void;
}): JSX.Element | null {
  return (
    <Delayed delayMs={props.delayMs} pending={props.pending}>
      <UnreachableScreen onRetry={props.onRetry} />
    </Delayed>
  );
}

/** `children` once `delayMs` has passed since mount; `pending` until then. */
function Delayed(props: {
  delayMs: number;
  pending: JSX.Element | null;
  children: JSX.Element;
}): JSX.Element | null {
  const { delayMs } = props;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return shown ? props.children : props.pending;
}

/**
 * A dropped connection after the page has been in use: under the top bar,
 * over the app but not in place of it. The bridge keeps redialling with
 * backoff; Retry dials now.
 */
export function ReconnectingPill(props: { onRetry: () => void }): JSX.Element {
  return (
    <div className={styles.pillDock}>
      <div className={styles.pill} role="status" data-testid="web-app-reconnecting">
        <span className={styles.spinner} aria-hidden />
        <span className={styles.pillLabel}>Reconnecting…</span>
        <Button variant="ghost" size="sm" className={styles.pillRetry} onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

const SKELETON_ROWS = ["70%", "90%", "55%", "80%", "40%"];

/** The phone shell's outline while the first connection is made. */
export function ConnectingSkeleton(): JSX.Element {
  return (
    <div
      className={styles.skeleton}
      role="status"
      aria-label="Connecting to Manor"
      data-testid="web-app-connecting"
    >
      <div className={styles.skeletonBar}>
        <div className={`${styles.bone} ${styles.boneIcon}`} />
        <div className={`${styles.bone} ${styles.boneTitle}`} />
        <div className={`${styles.bone} ${styles.boneIcon}`} />
      </div>
      <div className={styles.skeletonBody}>
        {SKELETON_ROWS.map((width, i) => (
          <div key={i} className={styles.skeletonRow}>
            <div className={`${styles.bone} ${styles.boneLine}`} style={{ width }} />
            <div className={`${styles.bone} ${styles.boneLine}`} style={{ width: "35%" }} />
          </div>
        ))}
      </div>
    </div>
  );
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
