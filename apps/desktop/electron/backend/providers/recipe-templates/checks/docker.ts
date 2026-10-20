/**
 * The `docker` template's checks: its choices — the
 * daemon's contexts, from `docker context ls` — and its checklist, in order:
 * the CLI is on PATH, the daemon answers, Manor's host image is on it (or
 * being pulled or built, with progress). A check after one that isn't `ok`
 * is `todo`. Its `run` fixes (`runFix`): open Docker, pull the image, build
 * it here.
 *
 * For "Another machine over SSH" the list starts with the
 * machine: it answers over SSH, Docker is installed there, the user may use
 * it (one `ssh … docker version` answers all three). Then the docker CLI
 * here, then the docker context Manor makes for it (`manor-<host>`, fix:
 * create it), then the daemon and image checks against that context.
 */

import {
  assertValidTarget,
  isHostKeyError,
  isRemoteAuthError,
  remoteShellCommand,
} from "../../../../terminal-host/ssh-config";
import { createContextArgs, dockerWhere, remoteContextName, SSH_TARGET_PATTERN, sshTargetParts } from "../docker";
import { defaultHostImage, type Choice, type TemplateCheck, type TemplateCheckResult } from "../types";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  failureLine,
  firstLine,
  hostImageDir,
  probeFailure,
  seconds,
  type CheckDeps,
} from "./deps";
import { jobKey, templateJobs, type JobState } from "./jobs";

/** The docker template's `run` fixes, by id. */
export const DOCKER_FIX = {
  openDocker: "open-docker",
  pullImage: "pull-image",
  buildImage: "build-image",
  createContext: "create-context",
} as const;

const GET_DOCKER_URL = "https://docs.docker.com/get-started/get-docker/";

interface DockerContextRow {
  Name?: unknown;
  Current?: unknown;
  DockerEndpoint?: unknown;
  Description?: unknown;
}

/**
 * `docker context ls --format '{{json .}}'`: one JSON object per line on
 * most versions, a single array on some. Rows without a name are skipped.
 */
export function parseDockerContexts(stdout: string): Choice[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  let rows: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  } else {
    rows = trimmed.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  }
  return rows.flatMap((row): Choice[] => {
    if (typeof row !== "object" || row === null) return [];
    const { Name, Current, DockerEndpoint } = row as DockerContextRow;
    if (typeof Name !== "string" || Name === "") return [];
    const current = Current === true || Current === "true";
    return [
      {
        value: Name,
        label: current ? `${Name} · Docker's current` : Name,
        ...(typeof DockerEndpoint === "string" && DockerEndpoint !== ""
          ? { hint: DockerEndpoint }
          : {}),
      },
    ];
  });
}

async function dockerContexts(deps: CheckDeps): Promise<Choice[]> {
  try {
    return parseDockerContexts(
      await deps.execFile("docker", ["context", "ls", "--format", "{{json .}}"]),
    );
  } catch {
    return [];
  }
}

/** The SSH machine a form runs Docker on, when its target is acceptable. */
interface RemoteMachine {
  /** As typed: `you@build-box`, `you@build-box:2222` or an alias. */
  target: string;
  /** The target's host, how rows name the machine. */
  host: string;
  /** The docker context Manor makes for it (`remoteContextName`). */
  context: string;
}

/** Where the form says to run Docker: here, an SSH machine, or an SSH target still to fix. */
type Where =
  | { kind: "local" }
  | { kind: "ssh"; machine: RemoteMachine }
  | { kind: "ssh-unusable"; target: string };

function whereOf(values: Record<string, string>): Where {
  let where: "local" | "ssh";
  try {
    where = dockerWhere(values);
  } catch {
    where = "local";
  }
  if (where === "local") return { kind: "local" };
  const target = (values.sshTarget ?? "").trim();
  if (!SSH_TARGET_PATTERN.test(target)) return { kind: "ssh-unusable", target };
  return {
    kind: "ssh",
    machine: { target, host: sshTargetParts(target).host, context: remoteContextName(target) },
  };
}

/** The Advanced "Docker context" field, as typed. */
function explicitContextOf(values: Record<string, string>): string {
  return (values.context ?? "").trim();
}

/**
 * The context the checks run against — the same precedence as the
 * template's `dockerContextFor`: the Advanced field, else the SSH machine's
 * own context, else none (Docker's current).
 */
function contextOf(values: Record<string, string>): string {
  const explicit = explicitContextOf(values);
  if (explicit !== "") return explicit;
  const where = whereOf(values);
  return where.kind === "ssh" ? where.machine.context : "";
}

/** How rows name where the image lives: "this computer", or the SSH machine's host. */
function placeOf(values: Record<string, string>): string {
  const where = whereOf(values);
  return where.kind === "ssh" ? where.machine.host : "this computer";
}

function contextArgs(values: Record<string, string>): string[] {
  const context = contextOf(values);
  return context ? ["--context", context] : [];
}

/** The image field, or the published image when it is blank. */
function imageOf(values: Record<string, string>, deps: CheckDeps): string {
  const image = (values.image ?? "").trim();
  if (image !== "") return image;
  return deps.appVersion ? defaultHostImage({ appVersion: deps.appVersion }) : "";
}

function todo(id: string, title: string): TemplateCheck {
  return { id, state: "todo", title };
}

/** The CLI row's title; `remoteHost` when Docker runs on an SSH machine, so "here" is said out loud. */
function cliTitle(remoteHost?: string): string {
  return remoteHost ? "Docker is installed on this computer" : "Docker is installed";
}

async function cliCheck(deps: CheckDeps, remoteHost?: string): Promise<TemplateCheck> {
  const id = "docker-cli";
  try {
    const out = await deps.execFile("docker", ["--version"]);
    return { id, state: "ok", title: cliTitle(remoteHost), detail: firstLine(out) || undefined };
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "missing") {
      return {
        id,
        state: "bad",
        title: remoteHost ? "Docker isn't installed on this computer" : "Docker isn't installed",
        detail: remoteHost
          ? `Manor needs the docker command here to reach Docker on ${remoteHost}.`
          : "Manor couldn't find the docker command on this computer.",
        fix: { kind: "url", label: "Get Docker Desktop", href: GET_DOCKER_URL },
      };
    }
    if (failure.kind === "timeout") {
      return { id, state: "bad", title: `Docker didn't answer within ${seconds()}` };
    }
    return { id, state: "bad", title: "Docker isn't working", detail: firstLine(failure.output) || undefined };
  }
}

interface DockerInfo {
  ServerVersion?: unknown;
  OSType?: unknown;
  Architecture?: unknown;
  ServerErrors?: unknown;
  ClientInfo?: { Context?: unknown };
}

function parseInfo(stdout: string): DockerInfo | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return typeof parsed === "object" && parsed !== null ? (parsed as DockerInfo) : undefined;
  } catch {
    return undefined;
  }
}

function serverErrors(info: DockerInfo | undefined): string {
  return Array.isArray(info?.ServerErrors)
    ? info.ServerErrors.filter((e): e is string => typeof e === "string").join("\n")
    : "";
}

/**
 * Whether Manor can start Docker here: Docker Desktop on macOS, or a
 * `docker-desktop` user unit on Linux, for a local daemon only.
 */
async function canOpenDocker(values: Record<string, string>, deps: CheckDeps): Promise<boolean> {
  const context = contextOf(values);
  if (context !== "" && context !== "default" && context !== "desktop-linux") return false;
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  try {
    const out = await deps.execFile("systemctl", [
      "--user",
      "list-unit-files",
      "docker-desktop.service",
      "--no-legend",
    ]);
    return out.includes("docker-desktop.service");
  } catch {
    return false;
  }
}

/** The daemon row's title when it passes (and while it waits). */
function daemonTitle(remoteHost?: string): string {
  return remoteHost ? `Manor can reach Docker on ${remoteHost}` : "Docker is running";
}

/** Add yourself to the docker group: what a refused socket needs, here or on the machine. */
function dockerGroupDetail(where: string): string {
  return `Permission denied on Docker's socket. Add yourself to the docker group${where}: sudo usermod -aG docker $USER, then sign out and back in.`;
}

async function daemonCheck(
  values: Record<string, string>,
  deps: CheckDeps,
  remoteHost?: string,
): Promise<TemplateCheck> {
  const id = "docker-daemon";
  let info: DockerInfo | undefined;
  let down: string;
  try {
    info = parseInfo(await deps.execFile("docker", [...contextArgs(values), "info", "--format", "json"]));
    down = serverErrors(info);
    if (down === "" && typeof info?.ServerVersion !== "string") down = "Docker's server didn't answer.";
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "timeout") {
      return {
        id,
        state: "bad",
        title: remoteHost
          ? `Docker on ${remoteHost} didn't answer within ${seconds()}`
          : `Docker didn't answer within ${seconds()}`,
        detail: "It may still be starting. This updates on its own.",
      };
    }
    if (failure.kind === "missing") {
      return {
        id,
        state: "bad",
        title: remoteHost ? "Docker isn't installed on this computer" : "Docker isn't installed",
      };
    }
    // `docker info` prints its (empty) JSON on stdout even when it fails;
    // the reason is on stderr.
    const stdout = failure.stdout.trim();
    const stderr = stdout && failure.output.endsWith(stdout) ? failure.output.slice(0, -stdout.length).trim() : "";
    down = serverErrors(parseInfo(failure.stdout)) || stderr || failure.output;
  }

  if (down === "") {
    const context =
      contextOf(values) || (typeof info?.ClientInfo?.Context === "string" ? info.ClientInfo.Context : "");
    const parts = [
      context ? `Context ${context}` : "",
      `Docker ${String(info?.ServerVersion)}`,
      typeof info?.OSType === "string" && typeof info.Architecture === "string"
        ? `${info.OSType}/${info.Architecture}`
        : "",
    ].filter((p) => p !== "");
    return { id, state: "ok", title: daemonTitle(remoteHost), detail: parts.join(" · ") };
  }

  if (/permission denied/i.test(down)) {
    return {
      id,
      state: "bad",
      title: remoteHost ? `Docker on ${remoteHost} won't let Manor in` : "Docker won't let Manor in",
      detail: remoteHost
        ? dockerGroupDetail(` on ${remoteHost}`)
        : "Permission denied on Docker's socket. Add yourself to the docker group, then sign out and back in.",
    };
  }
  const missingContext = /context "?([^"\s]+)"?\s*(?:does not exist|not found)/i.exec(down);
  if (missingContext) {
    return {
      id,
      state: "bad",
      title: `Docker has no context called ${missingContext[1]}`,
      detail: "Pick another context under Advanced, or leave it blank for the default.",
    };
  }
  if (remoteHost) {
    // Docker's ssh helper: "command [ssh … dial-stdio] has exited with …: stderr=<ssh's reason>".
    const viaSsh = /has exited with [^\n]*?stderr=([^\n]+)/.exec(down);
    return {
      id,
      state: "bad",
      title: `Manor can't reach Docker on ${remoteHost}`,
      detail: viaSsh
        ? `Docker's SSH connection to ${remoteHost} failed: ${viaSsh[1].trim()}`
        : failureLine(down) || "Docker didn't answer through its SSH context. This updates on its own.",
    };
  }
  const openable = await canOpenDocker(values, deps);
  const context = contextOf(values);
  return {
    id,
    state: "bad",
    title: "Docker isn't running",
    detail: `${openable ? "Start Docker Desktop" : "Start Docker"}, then this updates on its own.${
      context ? ` (Context ${context})` : ""
    }`,
    ...(openable ? { fix: { kind: "run" as const, id: DOCKER_FIX.openDocker, label: "Open Docker" } } : {}),
  };
}

/** Errors that mean the network is down, where building instead won't help. */
const NETWORK_DOWN = /dial tcp|no such host|i\/o timeout|TLS handshake timeout|network is unreachable/i;

/** The image row's title when it passes (and while it waits). */
function imageTitle(place: string): string {
  return `Manor's host image is on ${place}`;
}

function missingImage(image: string, job: JobState | undefined, place: string): TemplateCheck {
  const id = "docker-image";
  if (job?.status === "running") {
    return job.kind === "pull"
      ? { id, state: "busy", title: "Getting Manor's host image", detail: job.progress ?? "Starting the download" }
      : {
          id,
          state: "busy",
          title: `Building Manor's host image on ${place}`,
          detail: job.progress ?? "Starting the build",
        };
  }
  if (job?.status === "failed" && job.kind === "pull") {
    const line = failureLine(job.output ?? "");
    if (NETWORK_DOWN.test(job.output ?? "")) {
      return {
        id,
        state: "bad",
        title: "Manor's host image couldn't be downloaded",
        detail: `Check your internet connection.${line ? ` (${line})` : ""}`,
        fix: { kind: "run", id: DOCKER_FIX.pullImage, label: "Try again" },
      };
    }
    return {
      id,
      state: "bad",
      title: "Manor's host image couldn't be downloaded",
      detail: line || undefined,
      fix: { kind: "run", id: DOCKER_FIX.buildImage, label: `Build it on ${place} instead` },
    };
  }
  if (job?.status === "failed") {
    return {
      id,
      state: "bad",
      title: "Manor's host image couldn't be built",
      detail: failureLine(job.output ?? "") || undefined,
      fix: { kind: "run", id: DOCKER_FIX.buildImage, label: "Try again" },
    };
  }
  return {
    id,
    state: "bad",
    title: `Manor's host image isn't on ${place}`,
    detail: image,
    fix: { kind: "run", id: DOCKER_FIX.pullImage, label: "Download it" },
  };
}

async function imageCheck(values: Record<string, string>, deps: CheckDeps): Promise<TemplateCheck> {
  const id = "docker-image";
  const image = imageOf(values, deps);
  if (image === "") return { id, state: "bad", title: "Choose an image", detail: "The image field is empty." };
  const jobs = deps.jobs ?? templateJobs;
  const key = jobKey(contextOf(values), image);
  const place = placeOf(values);
  try {
    await deps.execFile("docker", [...contextArgs(values), "image", "inspect", "--format", "{{.Id}}", image]);
    jobs.clear(key);
    return { id, state: "ok", title: imageTitle(place), detail: image };
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "timeout") {
      return { id, state: "bad", title: `Docker didn't answer within ${seconds()}` };
    }
    if (failure.kind === "failed" && !/no such (image|object)|not found/i.test(failure.output)) {
      return {
        id,
        state: "bad",
        title: "Docker couldn't look for Manor's host image",
        detail: firstLine(failure.output) || undefined,
      };
    }
    return missingImage(image, jobs.get(key), place);
  }
}

async function checklist(values: Record<string, string>, deps: CheckDeps): Promise<TemplateCheck[]> {
  const where = whereOf(values);
  if (where.kind !== "local") return remoteChecklist(values, where, deps);
  const cli = await cliCheck(deps);
  if (cli.state !== "ok") {
    return [cli, todo("docker-daemon", daemonTitle()), todo("docker-image", imageTitle("this computer"))];
  }
  const daemon = await daemonCheck(values, deps);
  if (daemon.state !== "ok") return [cli, daemon, todo("docker-image", imageTitle("this computer"))];
  return [cli, daemon, await imageCheck(values, deps)];
}

// ─── Another machine over SSH ──────────────────────────────

/** ssh's own ConnectTimeout for the probe, in seconds. */
const SSH_CONNECT_TIMEOUT_S = 5;
/** The whole probe: connecting, then the machine's docker answering. */
const SSH_PROBE_TIMEOUT_MS = 10_000;
/** Run on the machine: proves ssh works, docker is there, and the user may use it. */
const REMOTE_DOCKER_PROBE = "docker version --format '{{.Server.Version}}'";

/**
 * `ssh` arguments that run `REMOTE_DOCKER_PROBE` on `target`: BatchMode
 * (no prompt to hang on), a short ConnectTimeout, and the target split the
 * way docker's own ssh helper does it (`-l user -p port -- host`), so a
 * docker-style `host:port` works and the user's `~/.ssh/config` still
 * applies. The snippet runs under `sh` whatever the login shell is.
 */
function sshProbeArgs(target: string): string[] {
  assertValidTarget(target);
  const { user, host, port } = sshTargetParts(target);
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    "-T",
    ...(user ? ["-l", user] : []),
    ...(port ? ["-p", port] : []),
    "--",
    host,
    remoteShellCommand(REMOTE_DOCKER_PROBE),
  ];
}

/**
 * The command to type in a terminal to reach `target`: plain `ssh` doesn't
 * read docker's `host:port`, so a port becomes `-p`.
 */
function terminalSsh(target: string): string {
  const { user, host, port } = sshTargetParts(target);
  return `ssh ${port ? `-p ${port} ` : ""}${user ? `${user}@` : ""}${host}`;
}

/**
 * What to do about a refused host key, worded as the SSH path's
 * `SshHostKeyError` words it, with the command spelled out for the target.
 */
function hostKeyDetail(target: string, output: string): string {
  const { host } = sshTargetParts(target);
  return output.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
    ? `${host}'s host key has changed since you last connected. If that is expected, remove the old key with ssh-keygen -R ${host}, then run ${terminalSsh(target)} once in a terminal to accept the new one.`
    : `Its host key isn't trusted yet. Run ${terminalSsh(target)} once in a terminal and accept it, then this updates on its own.`;
}

/** What to do about refused sign-in, as the SSH path's `SshAuthError` says it. */
function authDetail(target: string): string {
  return `Check that ${terminalSsh(target)} works in a terminal. If your key has a passphrase, add it to your agent with ssh-add: Manor can't answer a passphrase prompt.`;
}

const REMOTE_ROW = { reach: "ssh-reach", installed: "remote-docker", access: "remote-docker-access" } as const;

function remoteTitles(target: string, host: string) {
  return {
    reach: `${target} answers over SSH`,
    installed: `Docker is installed on ${host}`,
    access: `You can use Docker on ${host}`,
  };
}

/** A remote command that couldn't be found: sh, bash and zsh's ways of saying so. */
const COMMAND_NOT_FOUND = /docker: (?:command )?not found|command not found: docker/i;
const SOCKET_DENIED = /permission denied[^\n]*docker[^\n]*(?:sock|daemon)/i;
const DAEMON_DOWN = /Cannot connect to the Docker daemon|Is the docker daemon running/i;

/** How long a passing machine probe is reused: a pull's 2 s refreshes shouldn't each open an ssh connection. */
const PROBE_CACHE_MS = 15_000;
const probeCache = new Map<string, { rows: TemplateCheck[]; expires: number }>();

/** Forget cached machine probes. For tests. */
export function clearProbeCache(): void {
  probeCache.clear();
}

/**
 * The machine's three rows, reusing a passing answer for `PROBE_CACHE_MS`.
 * Failures are never cached, so a fix shows up at once.
 */
async function machineChecks(machine: RemoteMachine, deps: CheckDeps): Promise<TemplateCheck[]> {
  const now = (deps.now ?? Date.now)();
  const cached = probeCache.get(machine.target);
  if (cached && cached.expires > now) return cached.rows;
  const rows = await probeMachine(machine, deps);
  if (rows.every((c) => c.state === "ok")) {
    probeCache.set(machine.target, { rows, expires: now + PROBE_CACHE_MS });
  } else {
    probeCache.delete(machine.target);
  }
  return rows;
}

/**
 * The machine's three rows from one `ssh … docker version`: it answers
 * over SSH (host-key and sign-in failures told apart with the SSH path's own
 * `isHostKeyError` / `isRemoteAuthError`),
 * Docker is installed there, and the user may use it.
 */
async function probeMachine(machine: RemoteMachine, deps: CheckDeps): Promise<TemplateCheck[]> {
  const { target, host } = machine;
  const titles = remoteTitles(target, host);
  const reachBad = (title: string, detail?: string): TemplateCheck[] => [
    { id: REMOTE_ROW.reach, state: "bad", title, ...(detail ? { detail } : {}) },
    todo(REMOTE_ROW.installed, titles.installed),
    todo(REMOTE_ROW.access, titles.access),
  ];
  const reachOk: TemplateCheck = { id: REMOTE_ROW.reach, state: "ok", title: titles.reach };
  const installedOk: TemplateCheck = { id: REMOTE_ROW.installed, state: "ok", title: titles.installed };
  const accessBad = (title: string, detail?: string): TemplateCheck[] => [
    reachOk,
    installedOk,
    { id: REMOTE_ROW.access, state: "bad", title, ...(detail ? { detail } : {}) },
  ];

  try {
    const out = await deps.execFile("ssh", sshProbeArgs(target), { timeoutMs: SSH_PROBE_TIMEOUT_MS });
    const version = firstLine(out);
    return [
      reachOk,
      { ...installedOk, ...(version ? { detail: `Docker ${version}` } : {}) },
      { id: REMOTE_ROW.access, state: "ok", title: titles.access },
    ];
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "missing") {
      return reachBad("SSH isn't installed on this computer", `Manor uses the ssh command to reach ${host}.`);
    }
    if (failure.kind === "timeout") {
      return reachBad(
        `${target} didn't answer within ${seconds(SSH_PROBE_TIMEOUT_MS)}`,
        `Check that it is on, and that ${terminalSsh(target)} works in a terminal.`,
      );
    }
    const { output } = failure;
    // ssh's own failures exit 255; anything else came from the machine's shell.
    if (failure.code === 255 || failure.code === undefined) {
      if (isHostKeyError(output)) {
        return reachBad(`Manor doesn't trust ${host} yet`, hostKeyDetail(target, output));
      }
      if (isRemoteAuthError(output)) {
        return reachBad(`${host} didn't let Manor sign in`, authDetail(target));
      }
      if (/Could not resolve hostname/i.test(output)) {
        return reachBad(`Manor couldn't find ${host}`, "Check the name, or add a Host for it to ~/.ssh/config.");
      }
      if (failure.code === 255) {
        return reachBad(`${target} isn't answering over SSH`, failureLine(output) || undefined);
      }
    }
    if (failure.code === 127 || COMMAND_NOT_FOUND.test(output)) {
      return [
        reachOk,
        {
          id: REMOTE_ROW.installed,
          state: "bad",
          title: `Docker isn't installed on ${host}`,
          detail: "Install Docker Engine there, then this updates on its own.",
          fix: { kind: "url", label: "How to install Docker", href: GET_DOCKER_URL },
        },
        todo(REMOTE_ROW.access, titles.access),
      ];
    }
    if (SOCKET_DENIED.test(output)) {
      return accessBad(`Docker on ${host} won't let you in`, dockerGroupDetail(` on ${host}`));
    }
    if (DAEMON_DOWN.test(output)) {
      return accessBad(
        `Docker isn't running on ${host}`,
        "Start it there (for example sudo systemctl start docker), then this updates on its own.",
      );
    }
    return accessBad(`Docker on ${host} isn't working`, failureLine(output) || undefined);
  }
}

/** The context row's title when it passes (and while it waits). */
function contextTitle(host: string): string {
  return `Docker on ${host} is set up for Manor`;
}

/** `docker context inspect` of a context that isn't there. */
const MISSING_CONTEXT = /not found|does not exist/i;

/**
 * Where context `name` points (`ssh://you@build-box`), or null when there is
 * no such context. Rejects when docker can't say.
 */
async function contextEndpoint(name: string, deps: CheckDeps): Promise<string | null> {
  try {
    const out = await deps.execFile("docker", [
      "context",
      "inspect",
      "--format",
      "{{.Endpoints.docker.Host}}",
      name,
    ]);
    return out.trim();
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "failed" && MISSING_CONTEXT.test(failure.output)) return null;
    throw err;
  }
}

/** Whether a context's endpoint is `ssh://<target>` (a trailing slash aside). */
function pointsAt(endpoint: string, target: string): boolean {
  return endpoint.replace(/\/+$/, "") === `ssh://${target}`;
}

/**
 * Docker on the machine is set up for Manor: the context `manor-<host>`
 * exists and points at `ssh://<target>` (fix: create it). A context of that
 * name pointing elsewhere is the user's, so it is `bad` with no fix. With
 * the Advanced field filled in, that context is used as it is.
 */
async function contextCheck(
  values: Record<string, string>,
  machine: RemoteMachine,
  deps: CheckDeps,
): Promise<TemplateCheck> {
  const id = "docker-context";
  const { host, target, context } = machine;
  const title = contextTitle(host);
  const explicit = explicitContextOf(values);
  if (explicit !== "") {
    return { id, state: "ok", title, detail: `Uses Docker context ${explicit}, chosen under Advanced.` };
  }
  let endpoint: string | null;
  try {
    endpoint = await contextEndpoint(context, deps);
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "timeout") return { id, state: "bad", title: `Docker didn't answer within ${seconds()}` };
    return {
      id,
      state: "bad",
      title: "Docker couldn't look for its contexts",
      detail: failure.kind === "failed" ? firstLine(failure.output) || undefined : undefined,
    };
  }
  if (endpoint === null) {
    return {
      id,
      state: "bad",
      title: `Docker on ${host} isn't set up for Manor yet`,
      detail: `Manor makes a Docker context called ${context} that reaches ${host} over SSH.`,
      fix: { kind: "run", id: DOCKER_FIX.createContext, label: `Set up Docker on ${host}` },
    };
  }
  if (pointsAt(endpoint, target)) return { id, state: "ok", title, detail: `Context ${context} · ${endpoint}` };
  return {
    id,
    state: "bad",
    title: `Another Docker context is already called ${context}`,
    detail: `It points at ${endpoint || "something else"}, not ssh://${target}. Pick a context under Advanced, or remove that one yourself (docker context rm ${context}).`,
  };
}

/** The checklist for "Another machine over SSH": the machine's rows first, then the rest through its context. */
async function remoteChecklist(
  values: Record<string, string>,
  where: Exclude<Where, { kind: "local" }>,
  deps: CheckDeps,
): Promise<TemplateCheck[]> {
  const host = where.kind === "ssh" ? where.machine.host : "the machine";
  const titles = remoteTitles(where.kind === "ssh" ? where.machine.target : "The machine", host);
  const pending = (from: number): TemplateCheck[] =>
    [
      todo(REMOTE_ROW.installed, titles.installed),
      todo(REMOTE_ROW.access, titles.access),
      todo("docker-cli", cliTitle(host)),
      todo("docker-context", contextTitle(host)),
      todo("docker-daemon", daemonTitle(host)),
      todo("docker-image", imageTitle(host)),
    ].slice(from);

  if (where.kind === "ssh-unusable") {
    const first: TemplateCheck =
      where.target === ""
        ? { id: REMOTE_ROW.reach, state: "bad", title: "Enter the machine's SSH target" }
        : {
            id: REMOTE_ROW.reach,
            state: "bad",
            title: "That SSH target doesn't look right",
            detail: "Use you@host, you@host:2222, or a Host from your ~/.ssh/config.",
          };
    return [first, ...pending(0)];
  }

  const { machine } = where;
  const machineRows = await machineChecks(machine, deps);
  if (machineRows.some((c) => c.state !== "ok")) return [...machineRows, ...pending(2)];
  const cli = await cliCheck(deps, host);
  if (cli.state !== "ok") return [...machineRows, cli, ...pending(3)];
  const context = await contextCheck(values, machine, deps);
  if (context.state !== "ok") return [...machineRows, cli, context, ...pending(4)];
  const daemon = await daemonCheck(values, deps, host);
  if (daemon.state !== "ok") return [...machineRows, cli, context, daemon, ...pending(5)];
  return [...machineRows, cli, context, daemon, await imageCheck(values, deps)];
}

export async function check(
  values: Record<string, string>,
  deps: CheckDeps,
): Promise<TemplateCheckResult> {
  const [checks, contexts] = await Promise.all([checklist(values, deps), dockerContexts(deps)]);
  return { checks, choices: { context: contexts } };
}

/**
 * Make (or reuse) the docker context for the form's SSH machine:
 * `docker context create manor-<host> --docker host=ssh://<target>`. One
 * that already points there is kept; one of that name pointing elsewhere is
 * the user's, so this refuses rather than touch it.
 */
async function createContext(values: Record<string, string>, deps: CheckDeps): Promise<void> {
  const where = whereOf(values);
  if (where.kind !== "ssh") throw new Error("Enter the machine's SSH target first.");
  const { context, target } = where.machine;
  const endpoint = await contextEndpoint(context, deps);
  if (endpoint !== null) {
    if (pointsAt(endpoint, target)) return;
    throw new Error(
      `A Docker context called ${context} already points at ${endpoint || "something else"}. Manor won't change it.`,
    );
  }
  await deps.execFile("docker", createContextArgs(context, target));
}

/**
 * Carry out the docker template's fix `fixId` (`DOCKER_FIX`): open Docker,
 * set up the SSH machine's context, or start pulling or building the image
 * in the background. Returns once started; the next check shows how it is
 * going.
 */
export async function runFix(
  fixId: string,
  values: Record<string, string>,
  deps: CheckDeps,
): Promise<void> {
  if (fixId === DOCKER_FIX.createContext) {
    await createContext(values, deps);
    return;
  }
  if (fixId === DOCKER_FIX.openDocker) {
    const platform = deps.platform ?? process.platform;
    if (platform === "darwin") {
      await deps.execFile("open", ["-a", "Docker"], { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
    } else if (platform === "linux") {
      await deps.execFile("systemctl", ["--user", "start", "--no-block", "docker-desktop"]);
    } else {
      throw new Error("Manor can't start Docker on this computer. Start it yourself.");
    }
    return;
  }
  if (fixId === DOCKER_FIX.pullImage || fixId === DOCKER_FIX.buildImage) {
    const image = imageOf(values, deps);
    if (image === "") throw new Error("The image field is empty.");
    if (whereOf(values).kind === "ssh-unusable") throw new Error("Enter the machine's SSH target first.");
    const key = jobKey(contextOf(values), image);
    const jobs = deps.jobs ?? templateJobs;
    if (fixId === DOCKER_FIX.pullImage) {
      jobs.start(key, "pull", "docker", [...contextArgs(values), "pull", image]);
    } else {
      jobs.start(key, "build", "docker", [
        ...contextArgs(values),
        "build",
        "-t",
        image,
        deps.hostImageDir ?? hostImageDir(),
      ]);
    }
    return;
  }
  throw new Error(`Unknown fix: ${JSON.stringify(fixId)}`);
}
