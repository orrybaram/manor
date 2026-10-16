/**
 * ADR-234 D6: each template's checks list its `choice` fields' options from
 * the CLI, and list nothing (never throw) when the CLI is missing or its
 * output is unreadable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkTemplate, listTemplates } from "../providers/recipe-templates";
import type { CheckDeps } from "../providers/recipe-templates/checks";

/** A fake `execFile`: `answers[file]` is its stdout, or the error it fails with. */
function fakeDeps(answers: Record<string, string | Error>) {
  const execFile = vi.fn<CheckDeps["execFile"]>(async (file) => {
    const answer = answers[file];
    if (answer === undefined) {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    }
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { execFile };
}

const KUBECONFIG = JSON.stringify({
  kind: "Config",
  "current-context": "prod",
  clusters: [
    { name: "prod-cluster", cluster: { server: "https://prod.example:6443" } },
    { name: "kind-dev", cluster: { server: "https://127.0.0.1:41234" } },
  ],
  contexts: [
    { name: "prod", context: { cluster: "prod-cluster", user: "me" } },
    { name: "kind-dev", context: { cluster: "kind-dev", user: "kind-dev" } },
    { name: "orphan", context: { cluster: "gone", user: "me" } },
  ],
  users: [],
});

describe("kubernetes checks", () => {
  it("lists kubeconfig's contexts with their servers, labelling the current one", async () => {
    const deps = fakeDeps({ kubectl: KUBECONFIG });
    const result = await checkTemplate("kubernetes", {}, deps);
    expect(deps.execFile).toHaveBeenCalledWith("kubectl", ["config", "view", "-o", "json"]);
    expect(result.choices.context).toEqual([
      { value: "prod", label: "prod · kubectl's current", hint: "https://prod.example:6443" },
      { value: "kind-dev", label: "kind-dev", hint: "https://127.0.0.1:41234" },
      { value: "orphan", label: "orphan" },
    ]);
  });

  it("lists nothing when kubectl is missing", async () => {
    const result = await checkTemplate("kubernetes", {}, fakeDeps({}));
    expect(result.choices).toEqual({ context: [] });
  });

  it("lists nothing for a broken kubeconfig", async () => {
    const failing = await checkTemplate(
      "kubernetes",
      {},
      fakeDeps({ kubectl: new Error("error loading config file") }),
    );
    expect(failing.choices.context).toEqual([]);
    const garbled = await checkTemplate("kubernetes", {}, fakeDeps({ kubectl: "not json" }));
    expect(garbled.choices.context).toEqual([]);
    const empty = await checkTemplate("kubernetes", {}, fakeDeps({ kubectl: "{}" }));
    expect(empty.choices.context).toEqual([]);
  });
});

describe("kubernetes checks: the last used cluster (ADR-234 D5)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-recipes-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function recipe(id: string, template: string, context: string | undefined, mtimeSec: number) {
    fs.mkdirSync(path.join(dir, id));
    const file = path.join(dir, id, "recipe.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ template, env: context === undefined ? {} : { MANOR_K8S_CONTEXT: context } }),
    );
    fs.utimesSync(file, mtimeSec, mtimeSec);
  }

  const run = () =>
    checkTemplate("kubernetes", {}, { ...fakeDeps({ kubectl: KUBECONFIG }), recipesDir: dir });

  it("preselects the newest Kubernetes recipe's context, never kubectl's current one", async () => {
    recipe("old", "kubernetes", "prod", 1000);
    recipe("new", "kubernetes", "kind-dev", 2000);
    recipe("docker-newest", "docker", "orphan", 3000);
    expect((await run()).defaults).toEqual({ context: "kind-dev" });
  });

  it("skips contexts that are no longer listed, and recipes without one", async () => {
    recipe("gone", "kubernetes", "deleted-context", 3000);
    recipe("plain", "kubernetes", undefined, 2500);
    recipe("kept", "kubernetes", "orphan", 1000);
    expect((await run()).defaults).toEqual({ context: "orphan" });
  });

  it("preselects nothing without a Kubernetes recipe", async () => {
    recipe("docker", "docker", "prod", 1000);
    expect((await run()).defaults).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
    expect((await run()).defaults).toBeUndefined();
  });
});

describe("docker checks", () => {
  const LINES = [
    JSON.stringify({ Name: "default", Current: false, DockerEndpoint: "unix:///var/run/docker.sock" }),
    JSON.stringify({ Name: "colima", Current: true, DockerEndpoint: "unix:///home/me/.colima/docker.sock" }),
    JSON.stringify({ Name: "remote", Current: false, DockerEndpoint: "" }),
  ].join("\n");

  it("lists docker's contexts, one JSON object per line", async () => {
    const deps = fakeDeps({ docker: `${LINES}\n` });
    const result = await checkTemplate("docker", {}, deps);
    expect(deps.execFile).toHaveBeenCalledWith("docker", ["context", "ls", "--format", "{{json .}}"]);
    expect(result.choices.context).toEqual([
      { value: "default", label: "default", hint: "unix:///var/run/docker.sock" },
      { value: "colima", label: "colima · Docker's current", hint: "unix:///home/me/.colima/docker.sock" },
      { value: "remote", label: "remote" },
    ]);
  });

  it("reads a JSON array too, and skips unreadable rows", async () => {
    const out = JSON.stringify([{ Name: "default", Current: true }, { Current: false }, 3]);
    const result = await checkTemplate("docker", {}, fakeDeps({ docker: out }));
    expect(result.choices.context).toEqual([{ value: "default", label: "default · Docker's current" }]);
    const mixed = await checkTemplate(
      "docker",
      {},
      fakeDeps({ docker: `garbage\n${JSON.stringify({ Name: "x" })}` }),
    );
    expect(mixed.choices.context).toEqual([{ value: "x", label: "x" }]);
  });

  it("lists nothing when docker is missing or times out", async () => {
    expect((await checkTemplate("docker", {}, fakeDeps({}))).choices.context).toEqual([]);
    const timedOut = await checkTemplate(
      "docker",
      {},
      fakeDeps({ docker: Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }) }),
    );
    expect(timedOut.choices.context).toEqual([]);
  });
});

describe("checkTemplate", () => {
  it("rejects an unknown template", async () => {
    await expect(checkTemplate("nope", {}, fakeDeps({}))).rejects.toThrow(/Unknown template/);
  });

  it("describes both templates' context fields as choices", () => {
    for (const template of listTemplates({ appVersion: "1.2.3" })) {
      expect(template.fields.find((f) => f.key === "context")?.type).toBe("choice");
    }
  });
});
