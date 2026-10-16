/**
 * ADR-234 D8: each template's readiness checklist — every state of every
 * check, with a faked `execFile` — and its `run` fixes.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { checkTemplate, runTemplateFix } from "../providers/recipe-templates";
import type { CheckDeps } from "../providers/recipe-templates/checks";
import {
  TemplateJobs,
  type JobChild,
} from "../providers/recipe-templates/checks/jobs";

const enoent = () =>
  Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
const timeout = () =>
  Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
const failed = (stderr: string, stdout = "") =>
  Object.assign(new Error(`Command failed: x\n${stderr}`), {
    code: 1,
    stderr,
    stdout,
  });

type Answer = string | Error | (() => string | Error);

/**
 * A fake `execFile`: the first rule whose key starts the command line
 * (`file args...`) answers; no rule means the command isn't installed.
 */
function fakeExec(rules: Array<[string, Answer]>) {
  return vi.fn<CheckDeps["execFile"]>(async (file, args) => {
    const line = [file, ...args].join(" ");
    const rule = rules.find(([key]) => line.startsWith(key));
    if (!rule) throw enoent();
    const answer = typeof rule[1] === "function" ? rule[1]() : rule[1];
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

class FakeChild extends EventEmitter implements JobChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function fakeJobs() {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_file: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return { jobs: new TemplateJobs(spawn), spawn, children };
}

// ─── Docker ──────────────────────────────────────────────────────────────

const INFO = JSON.stringify({
  ServerVersion: "27.3.1",
  OSType: "linux",
  Architecture: "aarch64",
  ClientInfo: { Context: "desktop-linux" },
});
const IMAGE = "ghcr.io/orrybaram/manor-host:1.2.3";

function dockerDeps(
  rules: Array<[string, Answer]>,
  extra: Partial<CheckDeps> = {},
) {
  const execFile = fakeExec([["docker context ls", ""], ...rules]);
  return {
    appVersion: "1.2.3",
    platform: "darwin" as const,
    ...extra,
    execFile,
  };
}

const HEALTHY: Array<[string, Answer]> = [
  ["docker --version", "Docker version 27.3.1, build ce12230\n"],
  ["docker info", INFO],
];

describe("docker checklist", () => {
  it("is all ok with the CLI, a running daemon and the image", async () => {
    const deps = dockerDeps([
      ...HEALTHY,
      ["docker image inspect", "sha256:abc"],
    ]);
    const { checks } = await checkTemplate(
      "docker",
      { image: IMAGE, context: "" },
      deps,
    );
    expect(checks).toEqual([
      {
        id: "docker-cli",
        state: "ok",
        title: "Docker is installed",
        detail: "Docker version 27.3.1, build ce12230",
      },
      {
        id: "docker-daemon",
        state: "ok",
        title: "Docker is running",
        detail: "Context desktop-linux · Docker 27.3.1 · linux/aarch64",
      },
      {
        id: "docker-image",
        state: "ok",
        title: "Manor's host image is on this computer",
        detail: IMAGE,
      },
    ]);
    expect(deps.execFile).toHaveBeenCalledWith("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE,
    ]);
  });

  it("offers Docker Desktop when the CLI is missing, and leaves the rest todo", async () => {
    const { checks } = await checkTemplate("docker", {}, dockerDeps([]));
    expect(checks[0]).toMatchObject({
      state: "bad",
      title: "Docker isn't installed",
      fix: { kind: "url", label: "Get Docker Desktop" },
    });
    expect(checks.slice(1).map((c) => c.state)).toEqual(["todo", "todo"]);
  });

  it("says plainly when the CLI times out or fails", async () => {
    const slow = await checkTemplate(
      "docker",
      {},
      dockerDeps([["docker --version", timeout()]]),
    );
    expect(slow.checks[0]).toMatchObject({
      state: "bad",
      title: "Docker didn't answer within 5 seconds",
    });
    const broken = await checkTemplate(
      "docker",
      {},
      dockerDeps([["docker --version", failed("segfault")]]),
    );
    expect(broken.checks[0]).toMatchObject({
      state: "bad",
      title: "Docker isn't working",
      detail: "segfault",
    });
  });

  const DOWN = failed(
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  );

  it("offers to open Docker on macOS when the daemon is down", async () => {
    const { checks } = await checkTemplate(
      "docker",
      { image: IMAGE },
      dockerDeps([
        ["docker --version", "Docker version 27"],
        ["docker info", DOWN],
      ]),
    );
    expect(checks[1]).toEqual({
      id: "docker-daemon",
      state: "bad",
      title: "Docker isn't running",
      detail: "Start Docker Desktop, then this updates on its own.",
      fix: { kind: "run", id: "open-docker", label: "Open Docker" },
    });
    expect(checks[2]).toMatchObject({ id: "docker-image", state: "todo" });
  });

  it("reads a down daemon from `docker info`'s ServerErrors too", async () => {
    const { checks } = await checkTemplate(
      "docker",
      {},
      dockerDeps([
        ["docker --version", "Docker version 27"],
        [
          "docker info",
          failed(
            "",
            JSON.stringify({
              ServerErrors: ["Cannot connect to the Docker daemon"],
            }),
          ),
        ],
      ]),
    );
    expect(checks[1]).toMatchObject({
      state: "bad",
      title: "Docker isn't running",
    });
    const exitZero = await checkTemplate(
      "docker",
      {},
      dockerDeps([
        ["docker --version", "Docker version 27"],
        ["docker info", JSON.stringify({ ServerErrors: ["Cannot connect"] })],
      ]),
    );
    expect(exitZero.checks[1]).toMatchObject({
      state: "bad",
      title: "Docker isn't running",
    });
  });

  it("offers systemctl on Linux only when a docker-desktop user unit exists", async () => {
    const base: Array<[string, Answer]> = [
      ["docker --version", "Docker version 27"],
      ["docker info", DOWN],
    ];
    const withUnit = await checkTemplate(
      "docker",
      {},
      dockerDeps(
        [
          ...base,
          [
            "systemctl --user list-unit-files",
            "docker-desktop.service disabled enabled\n",
          ],
        ],
        { platform: "linux" },
      ),
    );
    expect(withUnit.checks[1].fix).toEqual({
      kind: "run",
      id: "open-docker",
      label: "Open Docker",
    });

    const without = await checkTemplate(
      "docker",
      {},
      dockerDeps([...base, ["systemctl --user list-unit-files", ""]], {
        platform: "linux",
      }),
    );
    expect(without.checks[1]).toEqual({
      id: "docker-daemon",
      state: "bad",
      title: "Docker isn't running",
      detail: "Start Docker, then this updates on its own.",
    });

    const windows = await checkTemplate(
      "docker",
      {},
      dockerDeps(base, { platform: "win32" }),
    );
    expect(windows.checks[1].fix).toBeUndefined();
  });

  it("passes the context, and offers no Open Docker for a remote one", async () => {
    const deps = dockerDeps([
      ["docker --version", "Docker version 27"],
      ["docker --context remote info", DOWN],
    ]);
    const { checks } = await checkTemplate(
      "docker",
      { context: "remote" },
      deps,
    );
    expect(deps.execFile).toHaveBeenCalledWith("docker", [
      "--context",
      "remote",
      "info",
      "--format",
      "json",
    ]);
    expect(checks[1]).toMatchObject({
      title: "Docker isn't running",
      detail: "Start Docker, then this updates on its own. (Context remote)",
    });
    expect(checks[1].fix).toBeUndefined();
  });

  it("names a refused socket, a missing context and a timeout", async () => {
    const run = (answer: Answer, values: Record<string, string> = {}) =>
      checkTemplate(
        "docker",
        values,
        dockerDeps([
          ["docker --version", "Docker version 27"],
          ["docker", answer],
        ]),
      );
    expect(
      (
        await run(
          failed(
            "permission denied while trying to connect to the Docker daemon socket",
          ),
        )
      ).checks[1],
    ).toMatchObject({ title: "Docker won't let Manor in" });
    expect(
      (await run(failed('context "nope" does not exist'), { context: "nope" }))
        .checks[1],
    ).toMatchObject({ title: "Docker has no context called nope" });
    expect((await run(timeout())).checks[1]).toMatchObject({
      state: "bad",
      title: "Docker didn't answer within 5 seconds",
    });
  });

  const MISSING: Array<[string, Answer]> = [
    ...HEALTHY,
    [
      "docker image inspect",
      failed(`Error response from daemon: No such image: ${IMAGE}`),
    ],
  ];

  it("offers to download a missing image, defaulting a blank field to the published one", async () => {
    const deps = dockerDeps(MISSING);
    const { checks } = await checkTemplate("docker", { image: "" }, deps);
    expect(checks[2]).toEqual({
      id: "docker-image",
      state: "bad",
      title: "Manor's host image isn't on this computer",
      detail: IMAGE,
      fix: { kind: "run", id: "pull-image", label: "Download it" },
    });
  });

  it("is busy with layer progress while pulling, then sees the image", async () => {
    const { jobs, spawn, children } = fakeJobs();
    let present = false;
    const deps = dockerDeps(
      [
        ...HEALTHY,
        [
          "docker image inspect",
          () => (present ? "sha256:x" : failed("No such image")),
        ],
      ],
      { jobs },
    );
    await runTemplateFix("docker", "pull-image", { image: IMAGE }, deps);
    expect(spawn).toHaveBeenCalledWith("docker", ["pull", IMAGE]);

    let { checks } = await checkTemplate("docker", { image: IMAGE }, deps);
    expect(checks[2]).toEqual({
      id: "docker-image",
      state: "busy",
      title: "Getting Manor's host image",
      detail: "Starting the download",
    });

    children[0].stdout.emit(
      "data",
      "1.2.3: Pulling from orrybaram/manor-host\naaaaaaaaaaaa: Pulling fs layer\n",
    );
    children[0].stdout.emit(
      "data",
      "bbbbbbbbbbbb: Already exists\naaaaaaaaaaaa: Downloading\n",
    );
    ({ checks } = await checkTemplate("docker", { image: IMAGE }, deps));
    expect(checks[2]).toMatchObject({ state: "busy", detail: "1 of 2 layers" });

    children[0].stdout.emit("data", "aaaaaaaaaaaa: Pull complete\n");
    present = true;
    children[0].emit("close", 0);
    ({ checks } = await checkTemplate("docker", { image: IMAGE }, deps));
    expect(checks[2]).toMatchObject({ state: "ok" });
  });

  it("offers to build when a pull fails for a reason other than the network", async () => {
    const { jobs, children } = fakeJobs();
    const deps = dockerDeps(MISSING, { jobs });
    await runTemplateFix("docker", "pull-image", { image: IMAGE }, deps);
    children[0].stderr.emit(
      "data",
      "Error response from daemon: manifest unknown\n",
    );
    children[0].emit("close", 1);
    const { checks } = await checkTemplate("docker", { image: IMAGE }, deps);
    expect(checks[2]).toEqual({
      id: "docker-image",
      state: "bad",
      title: "Manor's host image couldn't be downloaded",
      detail: "Error response from daemon: manifest unknown",
      fix: {
        kind: "run",
        id: "build-image",
        label: "Build it on this computer instead",
      },
    });
  });

  it("offers only a retry when the network is down", async () => {
    const { jobs, children } = fakeJobs();
    const deps = dockerDeps(MISSING, { jobs });
    await runTemplateFix("docker", "pull-image", { image: IMAGE }, deps);
    children[0].stderr.emit(
      "data",
      'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host\n',
    );
    children[0].emit("close", 1);
    const { checks } = await checkTemplate("docker", { image: IMAGE }, deps);
    expect(checks[2]).toMatchObject({
      state: "bad",
      title: "Manor's host image couldn't be downloaded",
      fix: { kind: "run", id: "pull-image", label: "Try again" },
    });
    expect(checks[2].detail).toMatch(/^Check your internet connection\. \(/);
  });

  it("builds from the bundled Dockerfile, busy with steps, and remembers a failed build", async () => {
    const { jobs, spawn, children } = fakeJobs();
    const deps = dockerDeps(MISSING, { jobs, hostImageDir: "/res/host-image" });
    await runTemplateFix(
      "docker",
      "build-image",
      { image: IMAGE, context: "colima" },
      deps,
    );
    expect(spawn).toHaveBeenCalledWith("docker", [
      "--context",
      "colima",
      "build",
      "-t",
      IMAGE,
      "/res/host-image",
    ]);
    const rules = [
      ["docker --version", "Docker version 27"],
      ["docker --context colima info", INFO],
      ["docker --context colima image inspect", failed("No such image")],
    ] as Array<[string, Answer]>;
    const colima = dockerDeps(rules, { jobs });
    children[0].stderr.emit("data", "#5 [2/6] RUN apt-get update\n");
    let { checks } = await checkTemplate(
      "docker",
      { image: IMAGE, context: "colima" },
      colima,
    );
    expect(checks[2]).toEqual({
      id: "docker-image",
      state: "busy",
      title: "Building Manor's host image on this computer",
      detail: "Step 2 of 6",
    });
    children[0].stderr.emit(
      "data",
      "ERROR: failed to solve: process did not complete\n",
    );
    children[0].emit("close", 1);
    ({ checks } = await checkTemplate(
      "docker",
      { image: IMAGE, context: "colima" },
      colima,
    ));
    expect(checks[2]).toEqual({
      id: "docker-image",
      state: "bad",
      title: "Manor's host image couldn't be built",
      detail: "ERROR: failed to solve: process did not complete",
      fix: { kind: "run", id: "build-image", label: "Try again" },
    });
  });

  it("reports an image probe that fails some other way, or times out", async () => {
    const other = await checkTemplate(
      "docker",
      { image: IMAGE },
      dockerDeps([
        ...HEALTHY,
        ["docker image inspect", failed("invalid reference format")],
      ]),
    );
    expect(other.checks[2]).toMatchObject({
      state: "bad",
      title: "Docker couldn't look for Manor's host image",
      detail: "invalid reference format",
    });
    const slow = await checkTemplate(
      "docker",
      { image: IMAGE },
      dockerDeps([...HEALTHY, ["docker image inspect", timeout()]]),
    );
    expect(slow.checks[2]).toMatchObject({
      state: "bad",
      title: "Docker didn't answer within 5 seconds",
    });
  });
});

describe("docker fixes", () => {
  it("opens Docker Desktop on macOS and the user unit on Linux, and refuses elsewhere", async () => {
    const mac = dockerDeps([["open", ""]]);
    await runTemplateFix("docker", "open-docker", {}, mac);
    expect(mac.execFile).toHaveBeenCalledWith(
      "open",
      ["-a", "Docker"],
      expect.anything(),
    );

    const linux = dockerDeps([["systemctl", ""]], { platform: "linux" });
    await runTemplateFix("docker", "open-docker", {}, linux);
    expect(linux.execFile).toHaveBeenCalledWith("systemctl", [
      "--user",
      "start",
      "--no-block",
      "docker-desktop",
    ]);

    await expect(
      runTemplateFix(
        "docker",
        "open-docker",
        {},
        dockerDeps([], { platform: "win32" }),
      ),
    ).rejects.toThrow(/can't start Docker/);
  });

  it("starts one pull per context and image, however often asked", async () => {
    const { jobs, spawn } = fakeJobs();
    const deps = dockerDeps([], { jobs });
    await runTemplateFix("docker", "pull-image", { image: IMAGE }, deps);
    await runTemplateFix("docker", "pull-image", { image: IMAGE }, deps);
    await runTemplateFix("docker", "build-image", { image: IMAGE }, deps);
    expect(spawn).toHaveBeenCalledTimes(1);
    await runTemplateFix(
      "docker",
      "pull-image",
      { image: IMAGE, context: "colima" },
      deps,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown fixes and templates", async () => {
    await expect(
      runTemplateFix("docker", "nope", {}, dockerDeps([])),
    ).rejects.toThrow(/Unknown fix/);
    await expect(
      runTemplateFix("kubernetes", "pull-image", {}, dockerDeps([])),
    ).rejects.toThrow(/Unknown fix/);
    await expect(
      runTemplateFix("nope", "pull-image", {}, dockerDeps([])),
    ).rejects.toThrow(/Unknown template/);
  });
});

// ─── Docker on another machine over SSH (ADR-234 D12) ────────────────────

const exited = (code: number, stderr: string) =>
  Object.assign(new Error(`Command failed: ssh\n${stderr}`), { code, stderr, stdout: "" });

const SSH = { where: "ssh", sshTarget: "me@build-box", image: IMAGE };
const CONTEXT_INSPECT = "docker context inspect --format {{.Endpoints.docker.Host}} manor-build-box";
const REMOTE_HEALTHY: Array<[string, Answer]> = [
  ["ssh", "27.3.1\n"],
  ["docker --version", "Docker version 27.3.1, build ce12230\n"],
  [CONTEXT_INSPECT, "ssh://me@build-box\n"],
  ["docker --context manor-build-box info", INFO],
];
const NO_CONTEXT = failed('context "manor-build-box": context not found: open /home/me/.docker/contexts/meta/x/meta.json: no such file or directory');

describe("docker checklist over SSH", () => {
  it("checks the machine, then its context, daemon and image, all through that context", async () => {
    const deps = dockerDeps([...REMOTE_HEALTHY, ["docker --context manor-build-box image inspect", "sha256:abc"]]);
    const { checks } = await checkTemplate("docker", SSH, deps);
    expect(checks.map((c) => [c.id, c.state, c.title])).toEqual([
      ["ssh-reach", "ok", "me@build-box answers over SSH"],
      ["remote-docker", "ok", "Docker is installed on build-box"],
      ["remote-docker-access", "ok", "You can use Docker on build-box"],
      ["docker-cli", "ok", "Docker is installed on this computer"],
      ["docker-context", "ok", "Docker on build-box is set up for Manor"],
      ["docker-daemon", "ok", "Manor can reach Docker on build-box"],
      ["docker-image", "ok", "Manor's host image is on build-box"],
    ]);
    expect(checks[1].detail).toBe("Docker 27.3.1");
    // BatchMode, a short ConnectTimeout, the target split as docker splits it.
    expect(deps.execFile).toHaveBeenCalledWith(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-T",
        "-l",
        "me",
        "--",
        "build-box",
        `exec sh -c 'docker version --format '"'"'{{.Server.Version}}'"'"''`,
      ],
      { timeoutMs: 10_000 },
    );
    expect(deps.execFile).toHaveBeenCalledWith("docker", [
      "--context",
      "manor-build-box",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE,
    ]);
  });

  it("passes a docker-style port to ssh with -p", async () => {
    const deps = dockerDeps([["ssh", "27.3.1"]]);
    await checkTemplate("docker", { ...SSH, sshTarget: "build-box:2222" }, deps);
    const args = deps.execFile.mock.calls.find(([file]) => file === "ssh")?.[1];
    expect(args?.slice(4, 8)).toEqual(["-T", "-p", "2222", "--"]);
    expect(args?.[8]).toBe("build-box");
  });

  it("asks for a target, and refuses one that doesn't look right, before running anything", async () => {
    const deps = dockerDeps([]);
    const blank = await checkTemplate("docker", { where: "ssh", sshTarget: " " }, deps);
    expect(blank.checks[0]).toMatchObject({ id: "ssh-reach", state: "bad", title: "Enter the machine's SSH target" });
    expect(blank.checks.slice(1).every((c) => c.state === "todo")).toBe(true);
    expect(blank.checks).toHaveLength(7);
    const bad = await checkTemplate("docker", { where: "ssh", sshTarget: "me@box; reboot" }, deps);
    expect(bad.checks[0]).toMatchObject({ state: "bad", title: "That SSH target doesn't look right" });
    expect(deps.execFile.mock.calls.some(([file]) => file === "ssh")).toBe(false);
  });

  it("tells an untrusted host key, a refused key, an unknown name and a dead machine apart", async () => {
    const run = async (answer: Answer) =>
      (await checkTemplate("docker", SSH, dockerDeps([["ssh", answer]]))).checks;

    const hostKey = await run(exited(255, "Host key verification failed."));
    expect(hostKey[0]).toMatchObject({ state: "bad", title: "Manor doesn't trust build-box yet" });
    expect(hostKey[0].detail).toMatch(/Run ssh me@build-box once in a terminal/);
    const changed = await run(exited(255, "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."));
    expect(changed[0].detail).toContain("ssh-keygen -R build-box");
    // Plain ssh doesn't read host:port: the command says -p.
    const ported = await checkTemplate(
      "docker",
      { ...SSH, sshTarget: "me@build-box:2222" },
      dockerDeps([["ssh", exited(255, "Host key verification failed.")]]),
    );
    expect(ported.checks[0].detail).toContain("Run ssh -p 2222 me@build-box once");
    expect(hostKey.slice(1).every((c) => c.state === "todo")).toBe(true);

    const auth = await run(exited(255, "me@build-box: Permission denied (publickey)."));
    expect(auth[0]).toMatchObject({ title: "build-box didn't let Manor sign in" });
    expect(auth[0].detail).toMatch(/ssh-add/);

    expect((await run(exited(255, "ssh: Could not resolve hostname build-box: Name or service not known")))[0])
      .toMatchObject({ title: "Manor couldn't find build-box" });
    expect((await run(exited(255, "ssh: connect to host build-box port 22: Connection refused")))[0]).toMatchObject({
      title: "me@build-box isn't answering over SSH",
      detail: "ssh: connect to host build-box port 22: Connection refused",
    });
    expect((await run(timeout()))[0]).toMatchObject({ title: "me@build-box didn't answer within 10 seconds" });
    expect((await run(enoent()))[0]).toMatchObject({ title: "SSH isn't installed on this computer" });
  });

  it("says when Docker is missing on the machine, refuses the user, or isn't running", async () => {
    const run = async (answer: Answer) =>
      (await checkTemplate("docker", SSH, dockerDeps([["ssh", answer]]))).checks;

    const missing = await run(exited(127, "sh: 1: docker: not found"));
    expect(missing.map((c) => c.state).slice(0, 3)).toEqual(["ok", "bad", "todo"]);
    expect(missing[1]).toMatchObject({
      title: "Docker isn't installed on build-box",
      fix: { kind: "url", label: "How to install Docker" },
    });

    const denied = await run(
      exited(1, "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"),
    );
    expect(denied.map((c) => c.state).slice(0, 4)).toEqual(["ok", "ok", "bad", "todo"]);
    expect(denied[2]).toMatchObject({ title: "Docker on build-box won't let you in" });
    expect(denied[2].detail).toContain("sudo usermod -aG docker $USER");

    const down = await run(exited(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
    expect(down[2]).toMatchObject({ state: "bad", title: "Docker isn't running on build-box" });
  });

  it("offers to set up the context when it is missing, and refuses one pointing elsewhere", async () => {
    const missing = await checkTemplate(
      "docker",
      SSH,
      dockerDeps([...REMOTE_HEALTHY.slice(0, 2), [CONTEXT_INSPECT, NO_CONTEXT]]),
    );
    expect(missing.checks[4]).toMatchObject({
      id: "docker-context",
      state: "bad",
      title: "Docker on build-box isn't set up for Manor yet",
      fix: { kind: "run", id: "create-context", label: "Set up Docker on build-box" },
    });
    expect(missing.checks.slice(5).map((c) => c.state)).toEqual(["todo", "todo"]);

    const elsewhere = await checkTemplate(
      "docker",
      SSH,
      dockerDeps([...REMOTE_HEALTHY.slice(0, 2), [CONTEXT_INSPECT, "ssh://someone@other-box\n"]]),
    );
    expect(elsewhere.checks[4]).toMatchObject({
      state: "bad",
      title: "Another Docker context is already called manor-build-box",
    });
    expect(elsewhere.checks[4].detail).toContain("ssh://someone@other-box");
    expect(elsewhere.checks[4].fix).toBeUndefined();
  });

  it("uses the Advanced context as it is, without making one", async () => {
    const deps = dockerDeps([
      ["ssh", "27.3.1"],
      ["docker --version", "Docker version 27"],
      ["docker --context mine info", INFO],
      ["docker --context mine image inspect", "sha256:abc"],
    ]);
    const { checks } = await checkTemplate("docker", { ...SSH, context: "mine" }, deps);
    expect(checks.every((c) => c.state === "ok")).toBe(true);
    expect(checks[4].detail).toBe("Uses Docker context mine, chosen under Advanced.");
    expect(deps.execFile.mock.calls.some(([, args]) => args.includes("inspect") && args.includes("manor-build-box"))).toBe(false);
  });

  it("says plainly when Docker can't be reached through the context", async () => {
    const { checks } = await checkTemplate(
      "docker",
      SSH,
      dockerDeps([
        ...REMOTE_HEALTHY.slice(0, 3),
        [
          "docker --context manor-build-box info",
          failed("error during connect: ssh: connect to host build-box port 22: Connection refused"),
        ],
      ]),
    );
    expect(checks[5]).toMatchObject({
      state: "bad",
      title: "Manor can't reach Docker on build-box",
      detail: "error during connect: ssh: connect to host build-box port 22: Connection refused",
    });
    expect(checks[5].fix).toBeUndefined();

    // As docker 29 really says it, with JSON on stdout.
    const viaSsh = await checkTemplate(
      "docker",
      SSH,
      dockerDeps([
        ...REMOTE_HEALTHY.slice(0, 3),
        [
          "docker --context manor-build-box info",
          failed(
            'error during connect: Get "http://docker.example.com/v1.52/info": command [ssh -l me -o ConnectTimeout=30 -T -- build-box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=Host key verification failed.',
            JSON.stringify({ ID: "", ServerVersion: "", Swarm: { Error: "" } }),
          ),
        ],
      ]),
    );
    expect(viaSsh.checks[5].detail).toBe("Docker's SSH connection to build-box failed: Host key verification failed.");
  });

  it("pulls and builds on the machine, keyed by its context", async () => {
    const { jobs, spawn } = fakeJobs();
    await runTemplateFix("docker", "pull-image", SSH, dockerDeps([], { jobs }));
    expect(spawn).toHaveBeenCalledWith("docker", ["--context", "manor-build-box", "pull", IMAGE]);
    const { checks } = await checkTemplate(
      "docker",
      SSH,
      dockerDeps(
        [...REMOTE_HEALTHY, ["docker --context manor-build-box image inspect", failed(`No such image: ${IMAGE}`)]],
        { jobs },
      ),
    );
    expect(checks[6]).toMatchObject({ state: "busy", title: "Getting Manor's host image" });
    await expect(
      runTemplateFix("docker", "pull-image", { where: "ssh", sshTarget: "", image: IMAGE }, dockerDeps([], { jobs })),
    ).rejects.toThrow(/SSH target/);
  });
});

describe("docker fix: set up the SSH machine's context", () => {
  it("creates manor-<host> pointing at ssh://<target> when it is missing", async () => {
    const deps = dockerDeps([[CONTEXT_INSPECT, NO_CONTEXT], ["docker context create", ""]]);
    await runTemplateFix("docker", "create-context", SSH, deps);
    expect(deps.execFile).toHaveBeenCalledWith("docker", [
      "context",
      "create",
      "manor-build-box",
      "--description",
      "Made by Manor for ssh://me@build-box",
      "--docker",
      "host=ssh://me@build-box",
    ]);
  });

  it("keeps one that already points there", async () => {
    const deps = dockerDeps([[CONTEXT_INSPECT, "ssh://me@build-box/\n"]]);
    await runTemplateFix("docker", "create-context", SSH, deps);
    expect(deps.execFile.mock.calls.some(([, args]) => args[1] === "create")).toBe(false);
  });

  it("refuses to touch one of that name pointing elsewhere", async () => {
    const deps = dockerDeps([[CONTEXT_INSPECT, "ssh://someone@other-box"]]);
    await expect(runTemplateFix("docker", "create-context", SSH, deps)).rejects.toThrow(
      /already points at ssh:\/\/someone@other-box/,
    );
    expect(deps.execFile.mock.calls.some(([, args]) => args[1] === "create")).toBe(false);
  });

  it("needs a usable target, and docker to answer", async () => {
    await expect(
      runTemplateFix("docker", "create-context", { where: "local" }, dockerDeps([])),
    ).rejects.toThrow(/SSH target/);
    await expect(
      runTemplateFix("docker", "create-context", SSH, dockerDeps([[CONTEXT_INSPECT, timeout()]])),
    ).rejects.toThrow();
  });
});

// ─── Kubernetes ──────────────────────────────────────────────────────────

const K = "kubectl --context c";
const CLIENT = JSON.stringify({ clientVersion: { gitVersion: "v1.31.0" } });
const SERVER = JSON.stringify({
  clientVersion: {},
  serverVersion: { gitVersion: "v1.30.2" },
});
const no = () => failed("", "no\n");
const classes = (
  ...items: Array<{ name: string; def?: "ga" | "beta"; provisioner?: string }>
) =>
  JSON.stringify({
    items: items.map(({ name, def, provisioner }) => ({
      metadata: {
        name,
        annotations:
          def === "ga"
            ? { "storageclass.kubernetes.io/is-default-class": "true" }
            : def === "beta"
              ? { "storageclass.beta.kubernetes.io/is-default-class": "true" }
              : {},
      },
      ...(provisioner ? { provisioner } : {}),
    })),
  });

/** A healthy cluster unless `rules` (checked first) say otherwise. */
function kubeDeps(rules: Array<[string, Answer]>) {
  const execFile = fakeExec([
    ["kubectl config view", "{}"],
    ...rules,
    ["kubectl version --client", CLIENT],
    [`${K} version`, SERVER],
    [`${K} get namespace manor`, "namespace/manor"],
    [`${K} auth can-i`, "yes\n"],
    [
      `${K} get storageclass`,
      classes({
        name: "standard",
        def: "ga",
        provisioner: "pd.csi.storage.gke.io",
      }),
    ],
  ]);
  return { execFile, recipesDir: "/nonexistent" };
}

const VALUES = { context: "c", namespace: "manor", storageClass: "" };

describe("kubernetes checklist", () => {
  it("is all ok on a healthy cluster", async () => {
    const deps = kubeDeps([]);
    const { checks, choices } = await checkTemplate("kubernetes", VALUES, deps);
    expect(checks).toEqual([
      {
        id: "kubectl-cli",
        state: "ok",
        title: "kubectl is installed",
        detail: "kubectl v1.31.0",
      },
      {
        id: "k8s-cluster",
        state: "ok",
        title: "The cluster answers",
        detail: "c · Kubernetes v1.30.2",
      },
      {
        id: "k8s-permissions",
        state: "ok",
        title: "You may deploy to namespace manor",
        detail: "Namespace manor",
      },
      {
        id: "k8s-storage",
        state: "ok",
        title: "The cluster has a default storage class",
        detail: "standard",
      },
    ]);
    expect(choices.storageClass).toEqual([
      {
        value: "standard",
        label: "standard · default",
        hint: "pd.csi.storage.gke.io",
      },
    ]);
    for (const resource of [
      "statefulsets",
      "secrets",
      "persistentvolumeclaims",
      "pods/exec",
    ]) {
      expect(deps.execFile).toHaveBeenCalledWith("kubectl", [
        "--context",
        "c",
        "auth",
        "can-i",
        "create",
        resource,
        "-n",
        "manor",
      ]);
    }
  });

  it("offers to install kubectl when it is missing, and leaves the rest todo", async () => {
    const { checks } = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([["kubectl version --client", enoent()]]),
    );
    expect(checks[0]).toMatchObject({
      state: "bad",
      title: "kubectl isn't installed",
      fix: {
        kind: "url",
        label: "Install kubectl",
        href: "https://kubernetes.io/docs/tasks/tools/",
      },
    });
    expect(checks.slice(1).map((c) => [c.id, c.state])).toEqual([
      ["k8s-cluster", "todo"],
      ["k8s-permissions", "todo"],
      ["k8s-storage", "todo"],
    ]);
  });

  it("asks for a cluster when none is chosen", async () => {
    const { checks } = await checkTemplate(
      "kubernetes",
      { ...VALUES, context: "" },
      kubeDeps([]),
    );
    expect(checks[1]).toMatchObject({
      id: "k8s-cluster",
      state: "bad",
      title: "Choose a cluster",
    });
    expect(checks[2].state).toBe("todo");
  });

  it("names a missing exec credential helper, with a link when it knows one", async () => {
    const gke = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [
          `${K} version`,
          failed(
            "E1015 getting credentials: exec: executable gke-gcloud-auth-plugin not found\n\nIt looks like you are trying to use a client-go credential plugin that is not installed.",
          ),
        ],
      ]),
    );
    expect(gke.checks[1]).toMatchObject({
      state: "bad",
      title: "The gke-gcloud-auth-plugin sign-in helper isn't installed",
      fix: { kind: "url", label: "Get gke-gcloud-auth-plugin" },
    });
    expect(gke.checks[1].detail).toMatch(
      /kubectl needs gke-gcloud-auth-plugin to sign in to c/,
    );

    const unknown = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [`${K} version`, failed("exec: executable my-helper not found")],
      ]),
    );
    expect(unknown.checks[1]).toMatchObject({
      title: "The my-helper sign-in helper isn't installed",
    });
    expect(unknown.checks[1].fix).toBeUndefined();
  });

  it("tells a timeout, refused credentials, a missing context and an unreachable cluster apart", async () => {
    const run = async (answer: Answer) =>
      (
        await checkTemplate(
          "kubernetes",
          VALUES,
          kubeDeps([[`${K} version`, answer]]),
        )
      ).checks[1];
    expect(await run(timeout())).toMatchObject({
      state: "bad",
      title: "The cluster didn't answer within 5 seconds",
    });
    expect(
      await run(
        failed("error: You must be logged in to the server (Unauthorized)"),
      ),
    ).toMatchObject({
      title: "The cluster doesn't accept your sign-in",
    });
    expect(
      await run(failed('error: context "c" does not exist')),
    ).toMatchObject({
      title: "kubectl has no cluster called c",
    });
    expect(
      await run(
        failed(
          "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
        ),
      ),
    ).toMatchObject({
      title: "The cluster isn't answering",
      detail:
        "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
    });
  });

  it("offers a namespace where everything passes when this one falls short", async () => {
    const { checks, choices } = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [`${K} auth can-i create secrets -n manor`, no()],
        [`${K} auth can-i create pods/exec -n manor`, no()],
        [`${K} get namespaces`, "default dev manor staging"],
        [`${K} auth can-i create secrets -n staging`, no()],
        [`${K} auth can-i create statefulsets -n default`, no()],
      ]),
    );
    expect(checks[2]).toEqual({
      id: "k8s-permissions",
      state: "bad",
      title: "You don't have permission to deploy to namespace manor",
      detail:
        "You can't create Secrets and exec into pods there. Namespace dev works.",
      fix: {
        kind: "set",
        label: "Use namespace dev",
        key: "namespace",
        value: "dev",
      },
    });
    expect(choices.namespace).toEqual([{ value: "dev", label: "dev" }]);
    expect(checks[3]).toMatchObject({ id: "k8s-storage", state: "todo" });
  });

  it("needs the namespace to exist or to be creatable", async () => {
    const creatable = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [
          `${K} get namespace manor`,
          failed('Error from server (NotFound): namespaces "manor" not found'),
        ],
      ]),
    );
    expect(creatable.checks[2]).toMatchObject({
      state: "ok",
      detail: "Manor will create namespace manor",
    });

    const existing = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([[`${K} auth can-i create namespaces`, no()]]),
    );
    expect(existing.checks[2]).toMatchObject({
      state: "ok",
      detail: "Namespace manor",
    });

    const neither = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [`${K} get namespace manor`, failed("Error from server (NotFound)")],
        [`${K} auth can-i create namespaces`, no()],
        [`${K} get namespaces`, failed("Error from server (Forbidden)")],
      ]),
    );
    expect(neither.checks[2]).toMatchObject({
      state: "bad",
      detail:
        "You can't create the namespace there. Ask your cluster admin for a namespace you can use.",
    });
    expect(neither.checks[2].fix).toBeUndefined();
    expect(neither.choices.namespace).toBeUndefined();
  });

  it("doesn't try every namespace on a big cluster", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `ns${i}`).join(" ");
    const deps = kubeDeps([
      [`${K} auth can-i create secrets -n manor`, no()],
      [`${K} get namespaces`, many],
    ]);
    const { checks } = await checkTemplate("kubernetes", VALUES, deps);
    expect(checks[2].detail).toMatch(/Ask your cluster admin/);
    expect(deps.execFile).not.toHaveBeenCalledWith(
      "kubectl",
      expect.arrayContaining(["-n", "ns0"]),
    );
  });

  it("says when permissions can't be checked", async () => {
    const broken = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [
          `${K} auth can-i create secrets -n manor`,
          failed("error: the server doesn't have a resource type"),
        ],
      ]),
    );
    expect(broken.checks[2]).toMatchObject({
      state: "bad",
      title: "Manor couldn't check your permissions",
    });
    const slow = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([[`${K} auth can-i`, timeout()]]),
    );
    expect(slow.checks[2]).toMatchObject({
      title: "The cluster didn't answer within 5 seconds",
    });
  });

  it("offers a storage class when there is no default", async () => {
    const { checks, choices } = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [`${K} get storageclass`, classes({ name: "fast" }, { name: "slow" })],
      ]),
    );
    expect(checks[3]).toEqual({
      id: "k8s-storage",
      state: "bad",
      title: "The cluster has no default storage class",
      detail: "Choose which storage class the host's disk comes from.",
      fix: {
        kind: "set",
        label: "Use fast",
        key: "storageClass",
        value: "fast",
      },
    });
    expect(choices.storageClass).toEqual([
      { value: "fast", label: "fast" },
      { value: "slow", label: "slow" },
    ]);
  });

  it("checks a chosen storage class exists, reading the beta default too", async () => {
    const list = classes({ name: "fast" }, { name: "std", def: "beta" });
    const ok = await checkTemplate(
      "kubernetes",
      { ...VALUES, storageClass: "fast" },
      kubeDeps([[`${K} get storageclass`, list]]),
    );
    expect(ok.checks[3]).toEqual({
      id: "k8s-storage",
      state: "ok",
      title: "The disk comes from storage class fast",
    });
    const gone = await checkTemplate(
      "kubernetes",
      { ...VALUES, storageClass: "gone" },
      kubeDeps([[`${K} get storageclass`, list]]),
    );
    expect(gone.checks[3]).toMatchObject({
      state: "bad",
      title: "The cluster has no storage class called gone",
      fix: { kind: "set", label: "Use std", key: "storageClass", value: "std" },
    });
  });

  it("blocks on no storage classes at all, but not on being forbidden to list them", async () => {
    const none = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([[`${K} get storageclass`, classes()]]),
    );
    expect(none.checks[3]).toMatchObject({
      state: "bad",
      title: "The cluster has no storage classes",
    });
    const forbidden = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([
        [
          `${K} get storageclass`,
          failed("Error from server (Forbidden): storageclasses is forbidden"),
        ],
      ]),
    );
    expect(forbidden.checks[3]).toMatchObject({ state: "ok" });
    const slow = await checkTemplate(
      "kubernetes",
      VALUES,
      kubeDeps([[`${K} get storageclass`, timeout()]]),
    );
    expect(slow.checks[3]).toMatchObject({
      state: "bad",
      title: "The cluster didn't answer within 5 seconds",
    });
  });
});
