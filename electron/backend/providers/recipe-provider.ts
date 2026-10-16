/**
 * RecipeHostProvider — a box Manor starts, stops and deletes with the
 * user's own commands (ADR-229 D2), reached over ssh or an exec prefix.
 *
 * - **`ensureUp` runs `up`** before every connect. `up` is idempotent: it
 *   creates the box if missing, resumes it if stopped, and says how to reach
 *   it. Its stderr lines are the host's progress, or once it names a stage
 *   (`manor-stage: <text>`, ADR-234 D9), that stage.
 * - **The way in is an inner provider**, rebuilt only when `up` says
 *   something different:
 *   - `ssh`: a `Host manor-<hostId>` block first in the transport's managed
 *     config, with the box's own `known_hosts`
 *     (`~/.manor/ssh/known_hosts.d/<hostId>`), then an `SshHostProvider` on
 *     that alias. A key `up` returns is written there, replacing any
 *     before; without one, the first connect takes the key (`accept-new`)
 *     and a changed one is refused after, as a `HostFailure`.
 *   - `exec`: a `CommandHostProvider` on the argv prefix (D3).
 *   The inner provider is this one's own: the registry, and `hosts.list`'s
 *   `providerKind`, only ever see this one, `kind: "recipe"`.
 * - **The transport exists before the box does.** A `RemoteBackend` is
 *   built with its transport when the host is registered, long before the
 *   first `up`. `transport()` therefore hands out one `RecipeTransport` for
 *   the provider's life, which forwards every call to the current inner
 *   provider's transport. The connection always runs `ensureUp` before the
 *   backend connects (`RemoteHostConnection.bringUp`), so by the time the
 *   backend asks, there is one; a call before then says the box isn't up.
 *   An inner provider replaced by a later `up` has its transport disposed,
 *   and the client's reconnect finds the new one through the same object.
 * - **`status`** runs the recipe's `status` when it has one; otherwise it is
 *   the state Manor last left the box in (`up` after `up`, `sleeping` after
 *   `stop`, remembered across restarts in `host.json`), and once up, the
 *   last connect's outcome.
 * - **`stop` and `destroy`** run their commands, and are offered only when
 *   the recipe declares them (`capabilities`). Removing the recipe's
 *   directory after a destroy is the caller's.
 */

import type { Duplex } from "node:stream";
import { hostKnownHostsDir, hostKnownHostsFile, hostRecipesDir } from "../../paths";
import { errorMessage } from "../../lib/errors";
import type { HostTransport } from "../../terminal-host/transport";
import type {
  BridgeSpawn,
  EnsureRemoteHost,
  RemoteExecOptions,
  RemoteExecResult,
} from "../../terminal-host/bridge-spawner";
import {
  knownHostsHasKey,
  recipeHostAlias,
  renderHostStanza,
  writeKnownHostKey,
} from "../../terminal-host/ssh-config";
import type { BootstrapProgress } from "../remote-bootstrap";
import { CommandHostProvider } from "./command-provider";
import { RecipeCommandError, runRecipeCommand, type RecipeSpawn } from "./recipe-runner";
import {
  parseStatusResult,
  parseUpResult,
  readRecipe,
  readRecipeHostState,
  recipeDir,
  writeRecipeHostState,
  RecipeError,
  type Recipe,
  type RecipeCommandName,
  type RecipeConnection,
  type RecipeSshTarget,
} from "./recipes";
import { SshHostProvider } from "./ssh-provider";
import type {
  HostProvider,
  PortForward,
  ProviderCapabilities,
  ProviderStatus,
} from "./types";

export interface RecipeHostProviderOptions {
  /** Bootstrap progress from the inner provider's host ensurer. */
  onBootstrapProgress?: (progress: BootstrapProgress) => void;
  /** Where recipes live. Defaults to `hostRecipesDir()`. For tests. */
  recipesDir?: string;
  /** Where each host's `known_hosts` goes. Defaults to `hostKnownHostsDir()`. For tests. */
  knownHostsDir?: string;
  /** Where the inner ssh transport's managed config goes. For tests. */
  configBaseDir?: string;
  /** Replaces the inner provider's host ensurer. For tests. */
  ensureRemoteHost?: EnsureRemoteHost;
  /** Spawns the inner exec provider's children. For tests. */
  execSpawn?: BridgeSpawn;
  /** Spawns the recipe's commands. For tests. */
  spawn?: RecipeSpawn;
}

/** What reaches the box once it is up. */
type InnerProvider = SshHostProvider | CommandHostProvider;

/**
 * `MANOR_INSTANCE_ID` (ADR-229 D6): the resource's id once `up` has
 * returned one — the resource itself when it is a string, its `id` when it
 * is an object with one — else the host id.
 */
export function recipeInstanceId(hostId: string, resource: unknown): string {
  if (typeof resource === "string" && resource !== "") return resource;
  if (typeof resource === "object" && resource !== null) {
    const id = (resource as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
    if (typeof id === "number") return String(id);
  }
  return hostId;
}

/** What a recipe prints on stderr to name the stage it is at (ADR-234 D9). */
const STAGE_PREFIX = "manor-stage: ";

/**
 * The progress for one run of a recipe command, given its stderr lines
 * (ADR-234 D9). A `manor-stage: <text>` line sets the progress to `<text>`;
 * once one has, other lines no longer replace it during that run. Before
 * any, every line is the progress, as before stages. Each run gets its own,
 * so a stage never carries over to the next. The lines themselves still
 * reach the command's output untouched: this only decides what is shown.
 */
export function stageProgress(onProgress?: (line: string) => void): ((line: string) => void) | undefined {
  if (!onProgress) return undefined;
  let staged = false;
  return (line) => {
    const bare = line.trimStart();
    if (bare.startsWith(STAGE_PREFIX)) {
      const stage = bare.slice(STAGE_PREFIX.length).trim();
      if (stage === "") return;
      staged = true;
      onProgress(stage);
    } else if (!staged) {
      onProgress(line);
    }
  };
}

/**
 * The provider's one transport for its whole life: every call goes to the
 * current inner provider's transport. See the file comment.
 */
class RecipeTransport implements HostTransport {
  constructor(
    private readonly current: () => HostTransport | null,
    private readonly label: () => string,
  ) {}

  get handshakeTimeoutMs(): number | undefined {
    return this.current()?.handshakeTimeoutMs;
  }

  async ensureRunning(version?: string): Promise<void> {
    return this.inner().ensureRunning(version);
  }

  async restart(version?: string): Promise<void> {
    return this.inner().restart(version);
  }

  async connectControl(): Promise<Duplex> {
    return this.inner().connectControl();
  }

  async connectStream(): Promise<Duplex> {
    return this.inner().connectStream();
  }

  async authToken(): Promise<string> {
    return this.inner().authToken();
  }

  async dispose(): Promise<void> {
    await this.current()?.dispose();
  }

  reset(): void {
    this.current()?.reset?.();
  }

  /** The way in's own `exec` (ssh or an exec prefix), for `manor-host` modes (ADR-229 D4). */
  async exec(command: string, opts?: RemoteExecOptions): Promise<RemoteExecResult> {
    const inner = this.inner();
    if (!inner.exec) throw new Error(`${this.label()} can't run commands`);
    return inner.exec(command, opts);
  }

  private inner(): HostTransport {
    const transport = this.current();
    if (!transport) throw new Error(`${this.label()} isn't up yet`);
    return transport;
  }
}

export class RecipeHostProvider implements HostProvider {
  readonly kind = "recipe" as const;
  /**
   * Whether any agent on the box is working (ADR-229 D7), from the host
   * server's `busyChanged`. Read by the desktop's idle stop.
   */
  busy = false;

  private readonly dir: string;
  private readonly knownHostsFile: string;
  private readonly alias: string;
  private readonly recipeTransport: RecipeTransport;
  /** The recipe as last read; null until it could be. */
  private recipe: Recipe | null = null;
  private inner: InnerProvider | null = null;
  /** `up`'s connection the inner provider was built for. */
  private connectionKey: string | null = null;
  private resource: unknown;
  private autoSleep = false;
  /** How Manor last left the box: what `status()` says without a `status` command. */
  private lastKnown: ProviderStatus;
  /** A `status` command in flight, which concurrent askers share. */
  private statusRun: Promise<ProviderStatus> | null = null;
  /** An `up` in flight, which concurrent `ensureUp` callers share. */
  private upRun: Promise<void> | null = null;

  constructor(
    readonly hostId: string,
    readonly recipeId: string,
    private readonly opts: RecipeHostProviderOptions = {},
  ) {
    this.dir = recipeDir(recipeId, opts.recipesDir ?? hostRecipesDir());
    this.knownHostsFile = hostKnownHostsFile(hostId, opts.knownHostsDir ?? hostKnownHostsDir());
    this.alias = recipeHostAlias(hostId);
    this.recipeTransport = new RecipeTransport(
      () => this.inner?.transport() ?? null,
      () => this.label,
    );
    const saved = readRecipeHostState(this.dir, hostId);
    this.resource = saved?.resource;
    this.autoSleep = saved?.autoSleep ?? false;
    this.lastKnown = { state: saved?.last === "sleeping" ? "sleeping" : "up" };
    // Read now for `capabilities` and the label; a recipe that can't be read
    // fails the first `ensureUp`, saying why, rather than the registration.
    try {
      this.recipe = this.readRecipe();
    } catch (err) {
      console.warn(`[recipe-provider] reading recipe "${recipeId}" failed:`, errorMessage(err));
    }
  }

  /** How messages name the box: the recipe's name, or its id. */
  get label(): string {
    return this.recipe?.name ?? this.recipeId;
  }

  /** What the recipe declares, and whether the last `up` said the provider sleeps it. */
  get capabilities(): ProviderCapabilities {
    return {
      canStop: this.recipe?.stop !== undefined,
      canDestroy: this.recipe?.destroy !== undefined,
      autoSleep: this.autoSleep,
    };
  }

  /**
   * The recipe's `idleStopMinutes` (ADR-229 D7): stop the box after this long
   * idle, while the desktop is awake. Undefined when the recipe has none.
   */
  get idleStopMinutes(): number | undefined {
    return this.recipe?.idleStopMinutes;
  }

  /** The one transport for the provider's life; see the file comment. */
  transport(): HostTransport {
    return this.recipeTransport;
  }

  /**
   * Run `up`, remember its resource, and build the way in when it changed.
   * Rejects with a `RecipeCommandError` or `RecipeError` saying what `up`
   * did wrong. Concurrent calls share one run.
   */
  ensureUp(onProgress?: (line: string) => void): Promise<void> {
    // A wake, a connect and a reconnect's re-run sharing one `up` (ADR-230
    // D2). Progress goes to the caller that started it.
    this.upRun ??= this.runUp(onProgress).finally(() => {
      this.upRun = null;
    });
    return this.upRun;
  }

  /**
   * Run `up` again during a reconnect (ADR-230 D2), unless the box may have
   * put itself to sleep: a recipe whose `up` said `autoSleep` and that has
   * no `status` to say otherwise would be woken by it (ADR-229 D1).
   *
   * Rebinding here is safe: `bind` replaces the inner provider only when
   * `up` says something different, and after a drop no stream rides the
   * old one's transport.
   */
  async refresh(onProgress?: (line: string) => void): Promise<boolean> {
    let recipe: Recipe;
    try {
      recipe = this.readRecipe();
    } catch {
      return false;
    }
    if (recipe.status === undefined && this.autoSleep) return false;
    await this.ensureUp(onProgress);
    return true;
  }

  private async runUp(onProgress?: (line: string) => void): Promise<void> {
    const prev = this.lastKnown;
    this.lastKnown = { state: "starting" };
    try {
      const raw = await this.run("up", stageProgress(onProgress));
      let result;
      try {
        result = parseUpResult(raw);
      } catch (err) {
        throw new RecipeCommandError("up", `${this.label}'s \`up\` result: ${errorMessage(err)}`, 0, "");
      }
      this.resource = result.resource;
      this.autoSleep = result.autoSleep ?? false;
      writeRecipeHostState(this.dir, {
        hostId: this.hostId,
        ...(result.resource !== undefined ? { resource: result.resource } : {}),
        autoSleep: this.autoSleep,
        last: "up",
      });
      await this.bind(result.connection);
      this.lastKnown = { state: "up" };
    } catch (err) {
      this.lastKnown =
        prev.state === "sleeping" ? prev : { state: "error", detail: errorMessage(err) };
      throw err;
    }
  }

  async status(): Promise<ProviderStatus> {
    let recipe: Recipe;
    try {
      recipe = this.readRecipe();
    } catch (err) {
      return { state: "error", detail: errorMessage(err) };
    }
    if (recipe.status === undefined) {
      if (this.lastKnown.state === "up" && this.inner) return this.inner.status();
      return { ...this.lastKnown };
    }
    this.statusRun ??= this.runStatus().finally(() => {
      this.statusRun = null;
    });
    return this.statusRun;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /** Run `stop`. Refused for a recipe without one. */
  async stop(): Promise<void> {
    await this.run("stop");
    this.lastKnown = { state: "sleeping" };
    writeRecipeHostState(this.dir, {
      hostId: this.hostId,
      ...(this.resource !== undefined ? { resource: this.resource } : {}),
      autoSleep: this.autoSleep,
      last: "sleeping",
    });
  }

  /**
   * Run `destroy`: the box and its disk are gone. The way in goes with it.
   * Refused for a recipe without one.
   */
  async destroy(): Promise<void> {
    await this.run("destroy");
    this.lastKnown = { state: "error", detail: `${this.label} was destroyed`, missing: true };
    this.resource = undefined;
    await this.unbind();
  }

  forwardPort(
    remotePort: number,
    opts?: { preferredLocalPort?: number; remoteHost?: string },
  ): Promise<PortForward> {
    if (!this.inner) return Promise.reject(new Error(`${this.label} isn't up yet`));
    return this.inner.forwardPort(remotePort, opts);
  }

  openServerChannel(): Promise<Duplex> {
    if (!this.inner) return Promise.reject(new Error(`${this.label} isn't up yet`));
    return this.inner.openServerChannel();
  }

  openViewerChannel(): Promise<Duplex> {
    if (!this.inner) return Promise.reject(new Error(`${this.label} isn't up yet`));
    return this.inner.openViewerChannel();
  }

  /** Release the inner provider's port forwards. Its transport is the client's. */
  async dispose(): Promise<void> {
    await this.inner?.dispose();
  }

  // ── Internal ──

  private readRecipe(): Recipe {
    this.recipe = readRecipe(this.recipeId, this.opts.recipesDir ?? hostRecipesDir());
    return this.recipe;
  }

  /** Run `command` from the recipe as it is on disk now. */
  private run(
    command: RecipeCommandName,
    onProgress?: (line: string) => void,
  ): Promise<Record<string, unknown>> {
    let recipe: Recipe;
    try {
      recipe = this.readRecipe();
    } catch (err) {
      return Promise.reject(err instanceof RecipeError ? err : new RecipeError(errorMessage(err)));
    }
    return runRecipeCommand(command, {
      recipe,
      dir: this.dir,
      hostId: this.hostId,
      instanceId: recipeInstanceId(this.hostId, this.resource),
      resource: this.resource,
      onProgress,
      spawn: this.opts.spawn,
    });
  }

  /** `status`, mapped to the provider's states (ADR-229 D2). Never rejects. */
  private async runStatus(): Promise<ProviderStatus> {
    try {
      const { state, detail } = parseStatusResult(await this.run("status"));
      switch (state) {
        case "up":
          return { state: "up", ...(detail ? { detail } : {}) };
        case "sleeping":
          return { state: "sleeping", ...(detail ? { detail } : {}) };
        case "missing":
          return { state: "error", detail: `${this.label} no longer exists`, missing: true };
        case "error":
          return { state: "error", detail: detail ?? `${this.label}'s \`status\` reported an error` };
      }
    } catch (err) {
      return { state: "error", detail: errorMessage(err) };
    }
  }

  /** Build the inner provider for `connection`, unless the current one is for it already. */
  private async bind(connection: RecipeConnection): Promise<void> {
    const key = JSON.stringify(connection);
    if (this.inner && key === this.connectionKey) return;
    const next =
      connection.type === "ssh" ? this.sshProvider(connection.target) : this.execProvider(connection.argv);
    await this.unbind();
    this.inner = next;
    this.connectionKey = key;
  }

  /** Let go of the inner provider: its forwards, and its transport's children. */
  private async unbind(): Promise<void> {
    const old = this.inner;
    this.inner = null;
    this.connectionKey = null;
    if (!old) return;
    await Promise.allSettled([old.dispose(), old.transport().dispose()]);
  }

  /**
   * An `SshHostProvider` on `manor-<hostId>`, its `Host` block carrying
   * `target` and the host's own `known_hosts` (ADR-229 D2). A key `up`
   * returned is the one trusted from now on.
   */
  private sshProvider(target: RecipeSshTarget): SshHostProvider {
    const { alias, knownHostsFile } = this;
    const { hostKey, ...where } = target;
    if (hostKey) writeKnownHostKey(knownHostsFile, alias, hostKey);
    const name = this.label;
    return new SshHostProvider(alias, {
      label: name,
      onBootstrapProgress: this.opts.onBootstrapProgress,
      ensureRemoteHost: this.opts.ensureRemoteHost,
      configBaseDir: this.opts.configBaseDir,
      // Read when the config is (re)created: once a first connect has taken
      // the key, checking is strict.
      hostStanza: () => renderHostStanza(alias, where, knownHostsFile, knownHostsHasKey(knownHostsFile)),
      hostKeyMessage: () =>
        hostKey
          ? `${name}'s host key doesn't match the one its recipe returned.`
          : `${name}'s host key changed and the recipe didn't vouch for the new one.`,
      // `ssh manor-<hostId>` works only through Manor's own config.
      authMessage: () =>
        `ssh could not log in to ${name} as ${where.username}@${where.host}. ` +
        `Check the user and identityFile its recipe's \`up\` returns, and that the key is loaded (\`ssh-add\`) ` +
        "if it has a passphrase: Manor cannot answer a passphrase prompt.",
    });
  }

  private execProvider(argv: string[]): CommandHostProvider {
    return new CommandHostProvider(argv, {
      label: this.label,
      onBootstrapProgress: this.opts.onBootstrapProgress,
      ensureRemoteHost: this.opts.ensureRemoteHost,
      spawn: this.opts.execSpawn,
    });
  }
}
