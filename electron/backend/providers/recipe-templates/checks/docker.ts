/**
 * The `docker` template's checks (ADR-234 D6, D8): its choices — the
 * daemon's contexts, from `docker context ls` — and its checklist, in order:
 * the CLI is on PATH, the daemon answers, Manor's host image is on it (or
 * being pulled or built, with progress). A check after one that isn't `ok`
 * is `todo`. Its `run` fixes (`runFix`): open Docker, pull the image, build
 * it here.
 */

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

function contextOf(values: Record<string, string>): string {
  return (values.context ?? "").trim();
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

async function cliCheck(deps: CheckDeps): Promise<TemplateCheck> {
  const id = "docker-cli";
  try {
    const out = await deps.execFile("docker", ["--version"]);
    return { id, state: "ok", title: "Docker is installed", detail: firstLine(out) || undefined };
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "missing") {
      return {
        id,
        state: "bad",
        title: "Docker isn't installed",
        detail: "Manor couldn't find the docker command on this computer.",
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

async function daemonCheck(values: Record<string, string>, deps: CheckDeps): Promise<TemplateCheck> {
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
        title: `Docker didn't answer within ${seconds()}`,
        detail: "It may still be starting. This updates on its own.",
      };
    }
    if (failure.kind === "missing") return { id, state: "bad", title: "Docker isn't installed" };
    down = serverErrors(parseInfo(failure.stdout)) || failure.output;
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
    return { id, state: "ok", title: "Docker is running", detail: parts.join(" · ") };
  }

  if (/permission denied/i.test(down)) {
    return {
      id,
      state: "bad",
      title: "Docker won't let Manor in",
      detail: "Permission denied on Docker's socket. Add yourself to the docker group, then sign out and back in.",
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

function missingImage(image: string, job: JobState | undefined): TemplateCheck {
  const id = "docker-image";
  if (job?.status === "running") {
    return job.kind === "pull"
      ? { id, state: "busy", title: "Getting Manor's host image", detail: job.progress ?? "Starting the download" }
      : {
          id,
          state: "busy",
          title: "Building Manor's host image on this computer",
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
      fix: { kind: "run", id: DOCKER_FIX.buildImage, label: "Build it on this computer instead" },
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
    title: "Manor's host image isn't on this computer",
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
  try {
    await deps.execFile("docker", [...contextArgs(values), "image", "inspect", "--format", "{{.Id}}", image]);
    jobs.clear(key);
    return { id, state: "ok", title: "Manor's host image is on this computer", detail: image };
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
    return missingImage(image, jobs.get(key));
  }
}

async function checklist(values: Record<string, string>, deps: CheckDeps): Promise<TemplateCheck[]> {
  const cli = await cliCheck(deps);
  if (cli.state !== "ok") {
    return [cli, todo("docker-daemon", "Docker is running"), todo("docker-image", "Manor's host image is on this computer")];
  }
  const daemon = await daemonCheck(values, deps);
  if (daemon.state !== "ok") return [cli, daemon, todo("docker-image", "Manor's host image is on this computer")];
  return [cli, daemon, await imageCheck(values, deps)];
}

export async function check(
  values: Record<string, string>,
  deps: CheckDeps,
): Promise<TemplateCheckResult> {
  const [checks, contexts] = await Promise.all([checklist(values, deps), dockerContexts(deps)]);
  return { checks, choices: { context: contexts } };
}

/**
 * Carry out the docker template's fix `fixId` (`DOCKER_FIX`): open Docker,
 * or start pulling or building the image in the background. Returns once
 * started; the next check shows how it is going.
 */
export async function runFix(
  fixId: string,
  values: Record<string, string>,
  deps: CheckDeps,
): Promise<void> {
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
