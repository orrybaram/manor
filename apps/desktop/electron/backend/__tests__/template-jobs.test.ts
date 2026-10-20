/**
 * The templates' background pulls and builds — one per key,
 * progress from their output, a remembered failure, killed on quit.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildProgress,
  jobKey,
  pullProgress,
  TemplateJobs,
  type JobChild,
} from "../providers/recipe-templates/checks/jobs";

class FakeChild extends EventEmitter implements JobChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function setup() {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_file: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return { jobs: new TemplateJobs(spawn), spawn, children };
}

const KEY = jobKey("", "img:1");

describe("TemplateJobs", () => {
  it("runs one job per key, and nothing remains after a success", () => {
    const { jobs, spawn, children } = setup();
    jobs.start(KEY, "pull", "docker", ["pull", "img:1"]);
    jobs.start(KEY, "pull", "docker", ["pull", "img:1"]);
    jobs.start(KEY, "build", "docker", ["build"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("docker", ["pull", "img:1"]);
    expect(jobs.get(KEY)).toEqual({ kind: "pull", status: "running" });

    jobs.start(jobKey("colima", "img:1"), "pull", "docker", []);
    expect(spawn).toHaveBeenCalledTimes(2);

    children[0].emit("close", 0);
    expect(jobs.get(KEY)).toBeUndefined();
  });

  it("tracks progress across split chunks and both streams", () => {
    const { jobs, children } = setup();
    jobs.start(KEY, "pull", "docker", []);
    children[0].stdout.emit(
      "data",
      Buffer.from("aaaaaaaaaaaa: Pulling fs layer\nbbbbbbbbbbbb: Pull"),
    );
    expect(jobs.get(KEY)?.progress).toBe("0 of 1 layers");
    children[0].stdout.emit("data", " complete\n");
    expect(jobs.get(KEY)?.progress).toBe("1 of 2 layers");
  });

  it("remembers the last lines of a failure, and a new start replaces it", () => {
    const { jobs, spawn, children } = setup();
    jobs.start(KEY, "pull", "docker", []);
    children[0].stdout.emit("data", "1.0: Pulling from x\n");
    children[0].stderr.emit("data", "Error response from daemon: denied\n");
    children[0].emit("close", 1);
    expect(jobs.get(KEY)).toEqual({
      kind: "pull",
      status: "failed",
      output: "1.0: Pulling from x\nError response from daemon: denied",
    });

    jobs.start(KEY, "build", "docker", ["build"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(jobs.get(KEY)).toEqual({ kind: "build", status: "running" });
  });

  it("says something even when a failed job printed nothing", () => {
    const { jobs, children } = setup();
    jobs.start(KEY, "pull", "docker", []);
    children[0].emit("close", 2);
    expect(jobs.get(KEY)?.output).toBe("docker exited with code 2");
  });

  it("records a spawn error once, whether it is emitted or thrown", () => {
    const { jobs, children } = setup();
    jobs.start(KEY, "pull", "docker", []);
    children[0].emit("error", new Error("spawn docker ENOENT"));
    children[0].emit("close", -2);
    expect(jobs.get(KEY)).toEqual({
      kind: "pull",
      status: "failed",
      output: "spawn docker ENOENT",
    });

    const throwing = new TemplateJobs(() => {
      throw new Error("EMFILE");
    });
    throwing.start(KEY, "build", "docker", []);
    expect(throwing.get(KEY)).toEqual({
      kind: "build",
      status: "failed",
      output: "EMFILE",
    });
  });

  it("clear forgets a failure but keeps a running job", () => {
    const { jobs, children } = setup();
    jobs.start(KEY, "pull", "docker", []);
    jobs.clear(KEY);
    expect(jobs.get(KEY)?.status).toBe("running");
    children[0].emit("close", 1);
    jobs.clear(KEY);
    expect(jobs.get(KEY)).toBeUndefined();
  });

  it("stopAll kills running jobs and forgets them all", () => {
    const { jobs, children } = setup();
    jobs.start(KEY, "pull", "docker", []);
    jobs.start("other", "build", "docker", []);
    children[1].emit("close", 1);
    jobs.stopAll();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[1].kill).not.toHaveBeenCalled();
    children[0].emit("close", null);
    expect(jobs.get(KEY)).toBeUndefined();
    expect(jobs.get("other")).toBeUndefined();
  });

  it("keeps a job's state its own: get returns a copy", () => {
    const { jobs } = setup();
    jobs.start(KEY, "pull", "docker", []);
    const state = jobs.get(KEY)!;
    state.status = "failed";
    expect(jobs.get(KEY)?.status).toBe("running");
  });
});

describe("progress parsers", () => {
  it("counts pulled layers, Already exists included", () => {
    const p = pullProgress();
    expect(p.text()).toBeUndefined();
    for (const line of [
      "latest: Pulling from orrybaram/manor-host",
      "aaaaaaaaaaaa: Already exists",
      "bbbbbbbbbbbb: Pulling fs layer",
      "cccccccccccc: Waiting",
      "bbbbbbbbbbbb: Downloading",
      "bbbbbbbbbbbb: Download complete",
      "bbbbbbbbbbbb: Pull complete",
      "Digest: sha256:0123",
    ]) {
      p.line(line);
    }
    expect(p.text()).toBe("2 of 3 layers");
  });

  it("reads BuildKit's and the classic builder's steps", () => {
    const kit = buildProgress();
    expect(kit.text()).toBeUndefined();
    kit.line("#4 [1/6] FROM docker.io/library/node:22");
    kit.line("#6 [3/6] RUN apt-get update");
    kit.line("#5 [2/6] COPY entrypoint.sh /");
    expect(kit.text()).toBe("Step 3 of 6");
    const classic = buildProgress();
    classic.line("Step 4/9 : RUN useradd manor");
    expect(classic.text()).toBe("Step 4 of 9");
  });
});
