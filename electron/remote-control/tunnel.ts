/**
 * Tunnel lifecycle for the remote-control listener (ADR-161 §3).
 *
 * The listener binds loopback and stays there. Making it reachable from a
 * phone is this module's job, and it is deliberately the *user's* action: the
 * tunnel is never started at launch, on restore, or as a side effect of
 * enabling remote control. Manor detects `tailscale` on `PATH` or inside the
 * Tailscale app bundle; it never bundles it, and installs it only when the
 * user presses Install in settings (a visible terminal running Homebrew).
 *
 * Tailscale is the only tunnel. With `tailscale serve` the device is already
 * authenticated at the network layer, so the bearer token is a second factor.
 * A public cloudflared quick tunnel used to be offered too, but there the token
 * was the only thing between the internet and a shell, so it was dropped.
 *
 * Two failure modes drive the design. The child must not outlive the app — a
 * tunnel nobody knows about is the whole hazard — so `stop()` is wired to
 * shutdown and waits for exit. And the child dying on its own must be visible,
 * because a UI still claiming "reachable" over a dead tunnel is the same lie in
 * the other direction; hence the `failed` state and the listener API.
 */

/**
 * Where the Tailscale app keeps its CLI. The app does not put `tailscale` on
 * PATH, but this binary *is* the CLI when invoked with arguments, and it talks
 * to the app's own daemon — so `serve` works without sudo.
 */
export const TAILSCALE_APP_CLI =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export type TunnelState = "stopped" | "starting" | "running" | "failed";

export interface TunnelStatus {
  state: TunnelState;
  /** Set only in `running`. */
  url: string | null;
  /** Set only in `failed`. Never contains a token. */
  error: string | null;
  /**
   * Set only in `starting`, when Tailscale is waiting on the user — e.g.
   * "Serve is not enabled on your tailnet. To enable, visit: <url>". The
   * child keeps polling and carries on by itself once the user has been there.
   */
  actionUrl?: string | null;
}

/** The subset of `ChildProcess` this module uses, so tests can fake it. */
export interface TunnelChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
}

export interface TunnelDeps {
  /** `backend.shell.which` — not a second `which` implementation. */
  which(bin: string): Promise<string | null>;
  spawn(command: string, args: string[]): TunnelChild;
  /** Run to completion and return stdout — `backend.shell.exec`. */
  exec(command: string, args: string[]): Promise<string>;
}

/** Another device on the user's tailnet, as `tailscale status` reports it. */
export interface TailnetPeer {
  name: string;
  os: string;
  online: boolean;
}

/**
 * Who else can reach a `*.ts.net` address. The address only opens on devices
 * in the tailnet, so "no peers" is the usual reason a phone cannot reach it —
 * worth saying on the card rather than leaving the user at "site can't be
 * reached".
 */
export interface TailnetInfo {
  /** The signed-in account, e.g. `someone@example.com`. */
  account: string | null;
  peers: TailnetPeer[];
}

interface StatusJsonNode {
  HostName?: string;
  OS?: string;
  Online?: boolean;
  UserID?: number;
}

/** Parse `tailscale status --json`. Null for anything that is not that shape. */
export function parseTailnet(json: string): TailnetInfo | null {
  let data: {
    Self?: StatusJsonNode;
    Peer?: Record<string, StatusJsonNode> | null;
    User?: Record<string, { LoginName?: string }> | null;
  };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !data.Self) return null;
  const selfUser =
    data.Self.UserID !== undefined
      ? data.User?.[String(data.Self.UserID)]
      : null;
  const peers = Object.values(data.Peer ?? {}).map((peer) => ({
    name: peer.HostName ?? "unknown",
    os: peer.OS ?? "",
    online: peer.Online === true,
  }));
  return { account: selfUser?.LoginName ?? null, peers };
}

/** Long enough for a cold `tailscale serve` to come up, short enough to fail. */
const START_TIMEOUT_MS = 30_000;
/**
 * Once Tailscale has asked the user to do something in the admin console, the
 * wait is on a person, not a process — give them time to sign in and click.
 */
const USER_ACTION_TIMEOUT_MS = 10 * 60_000;
const SIGTERM_GRACE_MS = 5_000;
const SIGKILL_GRACE_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// `tailscale serve` prints "Available within your tailnet:" then the URL.
const TAILSCALE_URL_PATTERN =
  /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?:\/\S*)?/i;

/**
 * A link Tailscale prints when it needs the user before it can serve — today
 * "Serve is not enabled on your tailnet. To enable, visit:" followed by a
 * `login.tailscale.com/f/serve?node=…` URL. Any admin-console link counts.
 */
const ACTION_URL_PATTERN = /https:\/\/login\.tailscale\.com\/\S+/i;

/**
 * What `start()` rejects with when `stop()` beat it. Marked so the caller can
 * tell a Cancel from a failure without racing on the reported state.
 */
export function cancelled(): Error & { cancelled: true } {
  return Object.assign(new Error("Tunnel start was cancelled"), {
    cancelled: true as const,
  });
}

export function isCancelled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { cancelled?: unknown }).cancelled === true
  );
}

/** The last non-empty line the child printed, for a timeout's error message. */
function lastLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : null;
}

function commandFor(port: number): [string, string[]] {
  const target = `http://127.0.0.1:${port}`;
  // Foreground on purpose: the serve config is torn down when the process
  // ends, so the tunnel cannot survive the app the way `--bg` would.
  return ["tailscale", ["serve", "--https=443", target]];
}

export class TunnelManager {
  private child: TunnelChild | null = null;
  /** Set across a deliberate `stop()`, so the child's exit is not "unexpected". */
  private stopping = false;
  private state: TunnelStatus = {
    state: "stopped",
    url: null,
    error: null,
  };
  private listeners = new Set<(status: TunnelStatus) => void>();
  /**
   * Cached by `detect()`. `tailnet()` reuses it rather than re-running
   * `which` on every 10-second poll while the tunnel is up.
   */
  private resolvedBinary: string | null = null;

  constructor(private readonly deps: TunnelDeps) {}

  get status(): TunnelStatus {
    return { ...this.state };
  }

  onStatus(listener: (status: TunnelStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether `tailscale` is on PATH or in the app bundle. */
  async detect(): Promise<boolean> {
    this.resolvedBinary = await this.deps.which("tailscale");
    return this.resolvedBinary !== null;
  }

  /** The tailnet as the CLI sees it, or null when it cannot be asked. */
  async tailnet(): Promise<TailnetInfo | null> {
    const bin = this.resolvedBinary;
    if (!bin) return null;
    try {
      return parseTailnet(await this.deps.exec(bin, ["status", "--json"]));
    } catch {
      // Logged out, daemon not running — the card has nothing to add then.
      return null;
    }
  }

  /**
   * Spawn the tunnel and resolve once its hostname appears in the child's
   * output. Rejects — having killed the child — if nothing appears in 30s, so
   * a half-started tunnel never leaves a process behind.
   */
  async start(port: number): Promise<{ url: string }> {
    if (this.state.state === "running" && this.state.url) {
      return { url: this.state.url };
    }
    if (this.child) await this.stop();

    const [command, args] = commandFor(port);
    this.setState({ state: "starting", url: null, error: null });

    // Spawn what `which` found — it may be the app bundle's CLI rather than a
    // `tailscale` on PATH.
    const resolved =
      this.resolvedBinary ??
      (await this.deps.which(command).catch(() => null)) ??
      command;
    // A `stop()` that landed during the lookup wins: nothing is spawned, and
    // the state it set is left alone.
    if (this.state.state !== "starting") {
      throw cancelled();
    }

    let child: TunnelChild;
    try {
      child = this.deps.spawn(resolved, args);
    } catch (err) {
      const error = `Could not start ${command}: ${String(err)}`;
      this.setState({ state: "failed", url: null, error });
      // `Object.assign` rather than the `cause` constructor option: this
      // module compiles against the ES2020 lib, where that overload does not
      // exist yet.
      throw Object.assign(new Error(error), { cause: err });
    }
    this.child = child;

    return new Promise<{ url: string }>((resolve, reject) => {
      let settled = false;
      const pattern = TAILSCALE_URL_PATTERN;
      let buffered = "";

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const fail = (message: string) => {
        finish(() => {
          this.setState({ state: "failed", url: null, error: message });
          // `killChild`, not `stop`: a failed tunnel must keep saying "failed"
          // with its reason, not quietly settle back to "stopped".
          void this.killChild();
          reject(new Error(message));
        });
      };

      let timer: ReturnType<typeof setTimeout>;
      let actionUrl: string | null = null;
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const said = lastLine(buffered);
          fail(
            actionUrl
              ? "Tailscale Serve was not enabled in time. Enable it for your tailnet, then try again."
              : `${command} did not report a URL within 30s${said ? `: ${said}` : ""}`,
          );
        }, ms);
        // A pending tunnel must never be the reason the app will not quit.
        timer.unref?.();
      };
      arm(START_TIMEOUT_MS);

      // The hostname lands on either stream depending on version, so watch
      // both and keep a rolling buffer — the URL can land split across chunk
      // boundaries.
      const onChunk = (chunk: Buffer | string) => {
        buffered = (buffered + String(chunk)).slice(-8192);
        const match = pattern.exec(buffered);
        if (!match) {
          const action = ACTION_URL_PATTERN.exec(buffered);
          if (action && !settled && action[0] !== actionUrl) {
            actionUrl = action[0];
            this.setState({
              state: "starting",
              url: null,
              error: null,
              actionUrl,
            });
            arm(USER_ACTION_TIMEOUT_MS);
          }
          return;
        }
        const url = match[0].replace(/\/$/, "");
        finish(() => {
          this.setState({ state: "running", url, error: null });
          resolve({ url });
        });
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      child.once("error", (err: Error) => {
        fail(`${command} failed to start: ${err.message}`);
      });

      child.once("exit", (code: number | null) => {
        this.child = null;
        if (!settled) {
          if (this.stopping) {
            // We killed it — Cancel during start. `stop()` reports "stopped".
            finish(() => reject(cancelled()));
            return;
          }
          fail(`${command} exited before reporting a URL (code ${code})`);
          return;
        }
        // Died after we were up. Say so rather than leaving the UI claiming
        // the machine is still reachable — unless we are the ones killing it.
        if (!this.stopping && this.state.state === "running") {
          this.setState({
            state: "failed",
            url: null,
            error: `${command} exited unexpectedly (code ${code})`,
          });
        }
      });
    });
  }

  /**
   * Synchronous last resort for `process.on("exit")`, where nothing may await.
   * `stop()` is the real path; this exists so a quit that skips `before-quit`
   * still cannot leave a tunnel pointed at this machine.
   */
  killNow(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.stopping = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }

  /** Idempotent, and waits for the child to actually be gone. */
  async stop(): Promise<void> {
    await this.killChild();
    this.setState({ state: "stopped", url: null, error: null });
  }

  /**
   * Terminate the child without touching the reported state — the caller
   * decides whether this was a stop or a failure.
   */
  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;

    this.stopping = true;
    try {
      let exitedAlready = false;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          exitedAlready = true;
          resolve();
        });
      });
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead.
      }
      await Promise.race([exited, delay(SIGTERM_GRACE_MS)]);
      if (exitedAlready) return;

      // A tunnel that ignores SIGTERM must not be able to hold up quit, and
      // "the app closed but the tunnel is still up" is the exact hazard this
      // module exists to prevent. Escalate, then stop waiting.
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead.
      }
      await Promise.race([exited, delay(SIGKILL_GRACE_MS)]);
    } finally {
      this.stopping = false;
    }
  }

  private setState(next: TunnelStatus): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener({ ...next });
  }
}
