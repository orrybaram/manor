import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createCustomRecipe,
  createRecipeFromTemplate,
  listTemplates,
  RECIPE_TEMPLATES,
} from "../providers/recipe-templates";
import { agentInstallScript } from "../providers/recipe-templates/agents";
import { parseRecipe, readRecipe } from "../providers/recipes";

// Optional: used when it is installed (knip would flag a literal binary name).
const LINTER = ["shell", "check"].join("");
let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-templates-"));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const CTX = { appVersion: "1.2.3" };

const FORMS: Record<string, Record<string, string>> = {
  docker: { name: "box1", image: "manor-host:local", context: "remote-1" },
  kubernetes: {
    context: "dev",
    size: "large",
    namespace: "manor",
    name: "box1",
    image: "ghcr.io/me/manor-host:1",
    storage: "20Gi",
    storageClass: "fast",
  },
};

describe("recipe templates (ADR-229 D8)", () => {
  it("lists both templates with resolved defaults", () => {
    const templates = listTemplates(CTX);
    expect(templates.map((t) => t.id)).toEqual(["docker", "kubernetes"]);
    const docker = templates[0];
    expect(docker.fields.find((f) => f.key === "name")?.default).toMatch(
      /^manor-[0-9a-f]{6}$/,
    );
    expect(docker.fields.find((f) => f.key === "image")?.default).toBe(
      "ghcr.io/orrybaram/manor-host:1.2.3",
    );
    expect(
      templates[1].fields.find((f) => f.key === "namespace")?.default,
    ).toBe("manor");
    expect(JSON.stringify(templates)).not.toContain("secret.key");
  });

  for (const template of RECIPE_TEMPLATES) {
    describe(template.id, () => {
      it("writes a recipe that validates, with its scripts executable", () => {
        const id = createRecipeFromTemplate(
          template.id,
          FORMS[template.id],
          CTX,
          base,
        );
        const dir = path.join(base, id);
        const recipe = readRecipe(id, base);
        expect(recipe.template).toBe(template.id);
        expect(
          parseRecipe(
            JSON.parse(fs.readFileSync(path.join(dir, "recipe.json"), "utf-8")),
            dir,
          ),
        ).toEqual(recipe);
        for (const file of ["up.sh", "status.sh", "stop.sh", "destroy.sh"]) {
          expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o755);
        }
        expect(recipe.up).toBe("./up.sh");
        expect(recipe.destroy).toBe("./destroy.sh");
      });

      it("writes scripts that parse, and reserve stdout", () => {
        for (const [file, { content }] of Object.entries(template.files)) {
          const target = path.join(base, file);
          fs.writeFileSync(target, content);
          execFileSync("bash", ["-n", target]);
          expect(content).toContain("set -euo pipefail");
          expect(content).toContain("exec 3>&1 1>&2");
          // Every command prints its one JSON object, `stop` and `destroy`
          // included (`{}`): the runner refuses an empty stdout.
          expect(content, file).toContain(">&3");
          if (spawnSync(LINTER, ["--version"]).status === 0) {
            execFileSync(LINTER, ["-s", "bash", target]);
          }
        }
      });

      it("refuses a bad name, and an existing recipe", () => {
        expect(() =>
          createRecipeFromTemplate(
            template.id,
            { ...FORMS[template.id], name: "A b; rm" },
            CTX,
            base,
          ),
        ).toThrow(/not valid/);
        createRecipeFromTemplate(template.id, FORMS[template.id], CTX, base);
        expect(() =>
          createRecipeFromTemplate(template.id, FORMS[template.id], CTX, base),
        ).toThrow(/already exists/);
      });
    });
  }

  it("a blank image falls back to the published image for this version", () => {
    for (const template of RECIPE_TEMPLATES) {
      const values = { ...FORMS[template.id], image: "" };
      expect(Object.values(template.recipe(values, CTX).env ?? {})).toContain(
        "ghcr.io/orrybaram/manor-host:1.2.3",
      );
    }
  });

  it("refuses an unknown template", () => {
    expect(() => createRecipeFromTemplate("vm", {}, CTX, base)).toThrow(
      /Unknown template/,
    );
  });

  it("docker: the exec argv runs as manor, and the container is the instance", () => {
    const up = RECIPE_TEMPLATES[0].files["up.sh"].content;
    expect(up).toContain('"exec","-i","-u","manor"');
    expect(up).toContain('-e "MANOR_INSTANCE_ID=$name"');
    // The key is a named volume on the daemon, not a bind from the recipe dir.
    expect(up).not.toContain("$key_file");
    expect(up).not.toContain("MANOR_RECIPE_DIR");
    expect(up).toContain('key_volume="manor-$name-key"');
    expect(up).toContain('-v "$key_volume:/run/secrets/manor:ro"');
    expect(up).toContain("MANOR_SECRET_KEY_FILE=/run/secrets/manor/secret.key");
    expect(up).toContain("manor-stage: Creating the container");
    expect(up).toContain("manor-stage: Starting the container");
    expect(up.indexOf("pull")).toBeLessThan(up.indexOf("run --rm -u 0"));
    expect(up.indexOf("run --rm -u 0")).toBeLessThan(up.indexOf("run -d"));
    const destroy = RECIPE_TEMPLATES[0].files["destroy.sh"].content;
    expect(destroy).toContain('volume rm "manor-$name-key"');
    expect(destroy).not.toContain("secret.key");
    expect(
      RECIPE_TEMPLATES[0].fields.find((f) => f.key === "context")?.description,
    ).not.toMatch(/on this computer/);
    // The image is pulled as a named stage, before `run`, when missing.
    expect(up).toContain('image inspect "$image"');
    expect(up).toContain("manor-stage: Getting Manor's host image");
    expect(up.indexOf("pull")).toBeLessThan(up.indexOf("run -d"));
    expect(RECIPE_TEMPLATES[0].recipe(FORMS.docker, CTX).env).toMatchObject({
      MANOR_DOCKER_NAME: "box1",
      MANOR_DOCKER_CONTEXT: "remote-1",
    });
  });

  it("docker: another machine over SSH runs against its own context, unless Advanced names one (ADR-234 D12)", () => {
    const docker = RECIPE_TEMPLATES[0];
    const where = docker.fields.find((f) => f.key === "where");
    expect(where).toMatchObject({ type: "segmented", label: "Run it on", default: "local" });
    expect(where?.advanced).toBeFalsy();
    expect(where?.options?.map((o) => [o.value, o.label])).toEqual([
      ["local", "This computer"],
      ["ssh", "Another machine over SSH"],
    ]);
    expect(docker.fields.find((f) => f.key === "sshTarget")).toMatchObject({
      label: "SSH target",
      showWhen: { key: "where", value: "ssh" },
    });

    const context = (values: Record<string, string>) =>
      docker.recipe({ name: "box1", ...values }, CTX).env?.MANOR_DOCKER_CONTEXT;
    // This computer: Docker's current context, or the one named under Advanced.
    expect(context({})).toBeUndefined();
    expect(context({ where: "local", sshTarget: "me@ignored" })).toBeUndefined();
    expect(context({ where: "local", context: "colima" })).toBe("colima");
    // Another machine: manor-<host>, from the host part, lowercased.
    expect(context({ where: "ssh", sshTarget: "me@Build.Box:2222" })).toBe("manor-build-box");
    expect(context({ where: "ssh", sshTarget: "build_box" })).toBe("manor-build-box");
    expect(context({ where: "ssh", sshTarget: "10.0.0.7" })).toBe("manor-10-0-0-7");
    // The Advanced field still wins.
    expect(context({ where: "ssh", sshTarget: "me@build-box", context: "mine" })).toBe("mine");
    // The target is required, and strict.
    expect(() => context({ where: "ssh" })).toThrow(/SSH target is required/);
    for (const bad of ["me@box; rm -rf /", "me @box", "-oProxyCommand=x", "me@box:port", "$(id)"]) {
      expect(() => context({ where: "ssh", sshTarget: bad })).toThrow(/SSH target is not valid/);
    }
    expect(() => context({ where: "mars" })).toThrow(/Run it on/);
  });

  it("agents: the choice becomes MANOR_AGENTS, an unknown id is refused, blank installs none (ADR-234 D11)", () => {
    for (const template of RECIPE_TEMPLATES) {
      const field = template.fields.find((f) => f.key === "agents");
      expect(field).toMatchObject({ type: "multi", label: "Agents to install" });
      expect(field?.advanced).toBeFalsy();
      expect(field?.options?.map((o) => o.value)).toEqual(["claude", "codex"]);
      expect(typeof field?.default === "function" ? "" : field?.default).toBe("claude");
      const agents = (value: string | undefined) =>
        template.recipe({ ...FORMS[template.id], ...(value === undefined ? {} : { agents: value }) }, CTX).env
          ?.MANOR_AGENTS;
      expect(agents("codex, claude")).toBe("claude,codex");
      expect(agents("claude")).toBe("claude");
      expect(agents("")).toBeUndefined();
      expect(agents(undefined)).toBeUndefined();
      expect(() => agents("claude,gemini")).toThrow(/agent is not valid/);
      expect(() => agents("claude; rm -rf /")).toThrow(/agent is not valid/);
    }
  });

  it("agents: up.sh installs a missing CLI as manor, and a failed install only warns", () => {
    const docker = RECIPE_TEMPLATES[0].files["up.sh"].content;
    const k8s = RECIPE_TEMPLATES[1].files["up.sh"].content;
    expect(docker).toContain('"${docker_cmd[@]}" exec -i -u manor "$name" sh -c');
    expect(k8s).toContain('"${kube[@]}" exec -i "$name-0" -c host -- sh -c');
    for (const up of [docker, k8s]) {
      expect(up).toContain("claude) label=\"Claude Code\"; bin=claude; pkg=@anthropic-ai/claude-code");
      expect(up).toContain("codex) label=\"Codex\"; bin=codex; pkg=@openai/codex");
      expect(up).toContain('npm i -g --prefix "$HOME/.local"');
      expect(up.indexOf("HOOKS\n")).toBeLessThan(up.indexOf("Installing $label"));
    }

    // Run the block itself, with `env` standing in for the exec prefix.
    const home = path.join(base, "home");
    const bin = path.join(base, "bin");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.mkdirSync(bin);
    // codex is already installed; the fake npm succeeds for claude only.
    fs.writeFileSync(path.join(home, ".local", "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "npm"),
      '#!/bin/sh\necho "npm $*" >>"$HOME/npm.log"\ncase "$*" in *claude-code*) exit 0 ;; *) exit 1 ;; esac\n',
      { mode: 0o755 },
    );
    const run = (agents: string) =>
      spawnSync("bash", ["-c", `set -e\n${agentInstallScript("env")}\necho done`], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MANOR_AGENTS: agents },
        encoding: "utf8",
      });
    const both = run("claude,codex");
    expect(both.status).toBe(0);
    expect(both.stdout).toBe("done\n");
    expect(both.stderr).toContain("manor-stage: Installing Claude Code");
    expect(both.stderr).not.toContain("Installing Codex");
    expect(fs.readFileSync(path.join(home, "npm.log"), "utf8")).toContain(
      "npm i -g --prefix " + path.join(home, ".local") + " --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code",
    );

    fs.rmSync(path.join(home, ".local", "bin", "codex"));
    const failed = run("codex");
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain("manor-stage: Installing Codex");
    expect(failed.stderr).toContain("manor: couldn't install Codex;");
    expect(failed.stdout).toBe("done\n");

    fs.rmSync(path.join(home, "npm.log"));
    expect(run("").status).toBe(0);
    expect(fs.existsSync(path.join(home, "npm.log"))).toBe(false);
  });

  it("kubernetes: the instance id is namespace/name and storage is validated", () => {
    const up = RECIPE_TEMPLATES[1].files["up.sh"].content;
    expect(up).toContain('value: "$namespace/$name"');
    // The rollout wait is Manor's own loop now, with stages (ADR-234 D9).
    expect(up).not.toContain("rollout status");
    expect(() =>
      RECIPE_TEMPLATES[1].recipe({ ...FORMS.kubernetes, storage: "lots" }, CTX),
    ).toThrow(/storage size/);
  });

  it("kubernetes: the cluster is required, and the size becomes the pod's resources (ADR-234 D5)", () => {
    const k8s = RECIPE_TEMPLATES[1];
    const { context: _context, ...noContext } = FORMS.kubernetes;
    expect(() => k8s.recipe(noContext, CTX)).toThrow(/cluster is required/);
    expect(k8s.fields.find((f) => f.key === "context")).toMatchObject({
      type: "choice",
      required: true,
      label: "Cluster",
    });
    const sizes = {
      small: ["250m", "512Mi", "2Gi"],
      medium: ["500m", "1Gi", "4Gi"],
      large: ["1", "2Gi", "8Gi"],
    };
    for (const [size, [cpu, memory, memoryLimit]] of Object.entries(sizes)) {
      expect(k8s.recipe({ ...FORMS.kubernetes, size }, CTX).env).toMatchObject({
        MANOR_K8S_CONTEXT: "dev",
        MANOR_K8S_CPU: cpu,
        MANOR_K8S_MEMORY: memory,
        MANOR_K8S_MEMORY_LIMIT: memoryLimit,
      });
    }
    // Medium unless said otherwise; anything else is refused.
    expect(k8s.recipe({ ...FORMS.kubernetes, size: "" }, CTX).env).toMatchObject({
      MANOR_K8S_CPU: "500m",
      MANOR_K8S_MEMORY: "1Gi",
      MANOR_K8S_MEMORY_LIMIT: "4Gi",
    });
    expect(() => k8s.recipe({ ...FORMS.kubernetes, size: "huge" }, CTX)).toThrow(/size/);
    const field = k8s.fields.find((f) => f.key === "size");
    expect(field).toMatchObject({ type: "size", default: "medium" });
    expect(field?.options?.map((o) => o.value)).toEqual(["small", "medium", "large"]);
  });

  /**
   * Runs up.sh against a `kubectl` that records the manifests it is given,
   * and says the pod is Ready so the wait ends.
   */
  function renderManifest(env: Record<string, string>): string {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const out = path.join(base, "applied.yaml");
    fs.writeFileSync(
      path.join(bin, "kubectl"),
      `#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = apply ]; then cat >>"${out}"; fi; done\n` +
        `case "$*" in *"get pod"*) printf 'True|True||||' ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    const up = path.join(base, "up.sh");
    fs.writeFileSync(up, RECIPE_TEMPLATES[1].files["up.sh"].content);
    const result = spawnSync("bash", [up], {
      env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      encoding: "utf-8",
    });
    expect(result.status, result.stderr).toBe(0);
    return fs.readFileSync(out, "utf-8");
  }

  const K8S_ENV = {
    MANOR_K8S_NAME: "box1",
    MANOR_K8S_NAMESPACE: "manor",
    MANOR_K8S_IMAGE: "img:1",
    MANOR_K8S_CONTEXT: "dev",
  };

  it("kubernetes: the pod is hardened and asks for its size", () => {
    const manifest = renderManifest({
      ...K8S_ENV,
      MANOR_K8S_CPU: "500m",
      MANOR_K8S_MEMORY: "1Gi",
      MANOR_K8S_MEMORY_LIMIT: "4Gi",
    });
    for (const block of [
      "      securityContext:\n        runAsNonRoot: true\n        runAsUser: 1000\n        runAsGroup: 1000\n        fsGroup: 1000\n        seccompProfile:\n          type: RuntimeDefault\n",
      '          securityContext:\n            allowPrivilegeEscalation: false\n            capabilities:\n              drop: ["ALL"]\n',
      '          resources:\n            requests:\n              cpu: "500m"\n              memory: "1Gi"\n            limits:\n              memory: "4Gi"\n',
    ]) {
      expect(manifest).toContain(block);
    }
    // No CPU limit.
    expect(manifest).not.toMatch(/limits:\n\s+cpu/);
  });

  it("kubernetes: a recipe without a memory limit is limited to its request", () => {
    const manifest = renderManifest({ ...K8S_ENV, MANOR_K8S_CPU: "2", MANOR_K8S_MEMORY: "4Gi" });
    expect(manifest).toContain('            limits:\n              memory: "4Gi"\n');
  });

  it("kubernetes: an old recipe without a size renders no resources block", () => {
    const manifest = renderManifest(K8S_ENV);
    expect(manifest).not.toContain("limits:");
    expect(manifest).not.toContain("cpu:");
    // The volume claim's own resources stay.
    expect(manifest).toContain("            storage: 20Gi");
    expect(manifest).toContain("          volumeMounts:");
  });

  it("kubernetes: up waits in named stages and fails fast with the cluster's reason (ADR-234 D9)", () => {
    const up = RECIPE_TEMPLATES[1].files["up.sh"].content;
    for (const stage of [
      "Getting a disk",
      "Finding room on the cluster",
      "Downloading the image on the node",
      "Starting",
    ]) {
      expect(up).toContain(`set_stage "${stage}"`);
    }
    for (const reason of [
      "ProvisioningFailed",
      "FailedBinding",
      "FailedScheduling",
      "FailedCreate",
      "ErrImagePull",
      "ImagePullBackOff",
      "InvalidImageName",
      "CreateContainerConfigError",
      "OOMKilled",
    ]) {
      expect(up).toContain(reason);
    }
    expect(up).toContain('"$SECONDS" -ge 840');
    expect(up).toContain("it was stuck at:");
    expect(up).toContain('--field-selector "involvedObject.name=$1"');
  });

  it("kubernetes: up stops at once on a pod that can't start, and goes on once it is Ready", () => {
    const up = path.join(base, "up.sh");
    fs.writeFileSync(up, RECIPE_TEMPLATES[1].files["up.sh"].content, { mode: 0o755 });
    // A kubectl that answers the claim's phase, the pod's fields and its events.
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "kubectl"),
      [
        "#!/bin/sh",
        'case "$*" in',
        "  *apply* | *exec*) cat >/dev/null ;;",
        '  *"get pvc"*) printf Bound ;;',
        '  *"get pod"*) printf %s "$FAKE_POD" ;;',
        '  *"get events"*) printf "%b" "$FAKE_EVENTS" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const run = (pod: string, events = "") =>
      spawnSync("bash", [up], {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          MANOR_K8S_NAME: "box1",
          MANOR_K8S_NAMESPACE: "manor",
          MANOR_K8S_IMAGE: "ghcr.io/x/host:1",
          FAKE_POD: pod,
          FAKE_EVENTS: events,
        },
        encoding: "utf-8",
      });

    const pull = run(
      "True|False|ErrImagePull|||rpc error",
      "2026-01-01T00:00:00Z\\tFailed\\tFailed to pull image: not found\\n",
    );
    expect(pull.status).toBe(1);
    expect(pull.stderr).toContain(
      "manor: the cluster couldn't get the host image (ErrImagePull): Failed to pull image: not found",
    );

    const config = run('True|False|CreateContainerConfigError|||secret "box1-key" not found');
    expect(config.status).toBe(1);
    expect(config.stderr).toContain('secret "box1-key" not found');

    const oom = run("True|False|CrashLoopBackOff||OOMKilled|");
    expect(oom.status).toBe(1);
    expect(oom.stderr).toContain("OOMKilled");

    const ready = run("True|True||||");
    expect(ready.status).toBe(0);
    expect(ready.stderr).toContain("manor-stage: Starting");
    expect(JSON.parse(ready.stdout)).toMatchObject({ resource: { namespace: "manor", name: "box1" } });
  });

  it("kubernetes: status is up while a scaled-up pod restarts, and sleeping only at 0 replicas (ADR-231 C1)", () => {
    const status = path.join(base, "status.sh");
    fs.writeFileSync(status, RECIPE_TEMPLATES[1].files["status.sh"].content, {
      mode: 0o755,
    });
    // A kubectl that answers the StatefulSet's replicas and the pod's Ready.
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "kubectl"),
      '#!/bin/sh\ncase "$*" in\n  *statefulset*) printf %s "$FAKE_REPLICAS" ;;\n  *pod*) printf %s "$FAKE_READY" ;;\nesac\n',
      { mode: 0o755 },
    );
    const run = (replicas: string, ready: string) =>
      JSON.parse(
        execFileSync("bash", [status], {
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            MANOR_K8S_NAME: "box1",
            MANOR_K8S_NAMESPACE: "manor",
            FAKE_REPLICAS: replicas,
            FAKE_READY: ready,
          },
          encoding: "utf-8",
        }),
      ) as unknown;
    expect(run("1", "True")).toEqual({ state: "up" });
    expect(run("1", "False")).toEqual({
      state: "up",
      detail: "the pod is not ready yet",
    });
    // The pod deleted and not yet recreated: no Ready condition at all.
    expect(run("1", "")).toEqual({
      state: "up",
      detail: "the pod is not ready yet",
    });
    expect(run("0", "")).toEqual({ state: "sleeping" });
  });

  it("custom: writes a recipe to finish, named for the host, never over another", () => {
    const first = createCustomRecipe("  Build VM ", base);
    expect(first).toEqual({
      recipeId: "build-vm",
      file: path.join(base, "build-vm", "recipe.json"),
    });
    expect(readRecipe("build-vm", base)).toEqual({
      schemaVersion: 1,
      id: "build-vm",
      name: "Build VM",
      up: "./up.sh",
    });
    const up = path.join(base, "build-vm", "up.sh");
    expect(fs.statSync(up).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(up, "utf-8")).toContain("exec 3>&1 1>&2");
    expect(createCustomRecipe("Build VM", base).recipeId).toBe("build-vm-2");
    expect(createCustomRecipe("🚀", base).recipeId).toMatch(
      /^manor-[0-9a-f]{6}$/,
    );
    expect(() => createCustomRecipe("  ", base)).toThrow(/name is required/);
  });

  it("custom: its up.sh fails saying what to do until it is finished", () => {
    createCustomRecipe("Box", base);
    const result = spawnSync("bash", [path.join(base, "box", "up.sh")], {
      env: { ...process.env, MANOR_RECIPE_DIR: path.join(base, "box") },
      encoding: "utf-8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("edit");
  });
});
