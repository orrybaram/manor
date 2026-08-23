/**
 * Tunnel lifecycle for the remote-control listener (ADR-161 §3).
 *
 * The listener binds loopback and stays there. Making it reachable from a
 * phone is this module's job, and it is deliberately the *user's* action: the
 * tunnel is never started at launch, on restore, or as a side effect of
 * enabling remote control. Manor detects `tailscale` and `cloudflared` on
 * `PATH`; it never installs or bundles either.
 *
 * Tailscale is preferred when both are present. The difference is not
 * convenience: with `tailscale serve` the device is already authenticated at
 * the network layer, so the bearer token becomes a second factor. With a
 * cloudflared quick tunnel the token is the only thing between the internet and
 * a shell.
 *
 * Two failure modes drive the design. The child must not outlive the app — a
 * tunnel nobody knows about is the whole hazard — so `stop()` is wired to
 * shutdown and waits for exit. And the child dying on its own must be visible,
 * because a UI still claiming "reachable" over a dead tunnel is the same lie in
 * the other direction; hence the `failed` state and the listener API.
 */

export type TunnelKind = "tailscale" | "cloudflared";
export type TunnelState = "stopped" | "starting" | "running" | "failed";

export interface TunnelStatus {
  state: TunnelState;
  kind: TunnelKind | null;
  /** Set only in `running`. */
  url: string | null;
  /** Set only in `failed`. Never contains a token. */
  error: string | null;
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
}

/** Long enough for a cold `cloudflared` to register an edge, short enough to fail. */
const START_TIMEOUT_MS = 30_000;
const SIGTERM_GRACE_MS = 5_000;
const SIGKILL_GRACE_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const URL_PATTERNS: Record<TunnelKind, RegExp> = {
  // `tailscale serve` prints "Available within your tailnet:" then the URL.
  tailscale: /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?:\/\S*)?/i,
  // A cloudflared quick tunnel prints its assigned hostname inside a box on
  // stderr: "https://<adjective-noun-noun-noun>.trycloudflare.com".
  cloudflared: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
};

function commandFor(kind: TunnelKind, port: number): [string, string[]] {
  const target = `http://127.0.0.1:${port}`;
  return kind === "tailscale"
    ? // Foreground on purpose: the serve config is torn down when the process
      // ends, so the tunnel cannot survive the app the way `--bg` would.
      ["tailscale", ["serve", "--https=443", target]]
    : ["cloudflared", ["tunnel", "--url", target]];
}

export class TunnelManager {
  private child: TunnelChild | null = null;
  /** Set across a deliberate `stop()`, so the child's exit is not "unexpected". */
  private stopping = false;
  private state: TunnelStatus = {
    state: "stopped",
    kind: null,
    url: null,
    error: null,
  };
  private listeners = new Set<(status: TunnelStatus) => void>();

  constructor(private readonly deps: TunnelDeps) {}

  get status(): TunnelStatus {
    return { ...this.state };
  }

  onStatus(listener: (status: TunnelStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async detect(): Promise<Record<TunnelKind, boolean>> {
    const [tailscale, cloudflared] = await Promise.all([
      this.deps.which("tailscale"),
      this.deps.which("cloudflared"),
    ]);
    return { tailscale: tailscale !== null, cloudflared: cloudflared !== null };
  }

  /** Tailscale when available — see the header for why that is not a taste call. */
  async preferredKind(): Promise<TunnelKind | null> {
    const found = await this.detect();
    if (found.tailscale) return "tailscale";
    if (found.cloudflared) return "cloudflared";
    return null;
  }

  /**
   * Spawn the tunnel and resolve once its hostname appears in the child's
   * output. Rejects — having killed the child — if nothing appears in 30s, so
   * a half-started tunnel never leaves a process behind.
   */
  async start(kind: TunnelKind, port: number): Promise<{ url: string }> {
    if (this.state.state === "running" && this.state.url) {
      return { url: this.state.url };
    }
    if (this.child) await this.stop();

    const [command, args] = commandFor(kind, port);
    this.setState({ state: "starting", kind, url: null, error: null });

    let child: TunnelChild;
    try {
      child = this.deps.spawn(command, args);
    } catch (err) {
      const error = `Could not start ${command}: ${String(err)}`;
      this.setState({ state: "failed", kind, url: null, error });
      // `Object.assign` rather than the `cause` constructor option: this
      // module compiles against the ES2020 lib, where that overload does not
      // exist yet.
      throw Object.assign(new Error(error), { cause: err });
    }
    this.child = child;

    return new Promise<{ url: string }>((resolve, reject) => {
      let settled = false;
      const pattern = URL_PATTERNS[kind];
      let buffered = "";

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const fail = (message: string) => {
        finish(() => {
          this.setState({ state: "failed", kind, url: null, error: message });
          // `killChild`, not `stop`: a failed tunnel must keep saying "failed"
          // with its reason, not quietly settle back to "stopped".
          void this.killChild();
          reject(new Error(message));
        });
      };

      const timer = setTimeout(() => {
        fail(`${command} did not report a URL within 30s`);
      }, START_TIMEOUT_MS);
      // A pending tunnel must never be the reason the app will not quit.
      timer.unref?.();

      // Both tools print the hostname on one of the two streams depending on
      // version, so watch both and keep a rolling buffer — the URL can land
      // split across chunk boundaries.
      const onChunk = (chunk: Buffer | string) => {
        buffered = (buffered + String(chunk)).slice(-8192);
        const match = pattern.exec(buffered);
        if (!match) return;
        const url = match[0].replace(/\/$/, "");
        finish(() => {
          this.setState({ state: "running", kind, url, error: null });
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
          fail(`${command} exited before reporting a URL (code ${code})`);
          return;
        }
        // Died after we were up. Say so rather than leaving the UI claiming
        // the machine is still reachable — unless we are the ones killing it.
        if (!this.stopping && this.state.state === "running") {
          this.setState({
            state: "failed",
            kind,
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
    this.setState({ state: "stopped", kind: null, url: null, error: null });
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
