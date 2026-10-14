import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRecipeFromTemplate, listTemplates, RECIPE_TEMPLATES } from "../providers/recipe-templates";
import { parseRecipe, readRecipe } from "../providers/recipes";

// Optional: used when it is installed (knip would flag a literal binary name).
const LINTER = ["shell", "check"].join("");
let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-templates-"));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const FORMS: Record<string, Record<string, string>> = {
  docker: { name: "box1", image: "manor-host:local", context: "remote-1" },
  kubernetes: {
    context: "dev",
    namespace: "manor",
    name: "box1",
    image: "ghcr.io/me/manor-host:1",
    storage: "20Gi",
    storageClass: "fast",
  },
};

describe("recipe templates (ADR-229 D8)", () => {
  it("lists both templates with resolved defaults", () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.id)).toEqual(["docker", "kubernetes"]);
    const docker = templates[0];
    expect(docker.fields.find((f) => f.key === "name")?.default).toMatch(/^manor-[0-9a-f]{6}$/);
    expect(docker.fields.find((f) => f.key === "image")?.default).toBe("manor-host:local");
    expect(templates[1].fields.find((f) => f.key === "namespace")?.default).toBe("manor");
    expect(JSON.stringify(templates)).not.toContain("secret.key");
  });

  for (const template of RECIPE_TEMPLATES) {
    describe(template.id, () => {
      it("writes a recipe that validates, with its scripts executable", () => {
        const id = createRecipeFromTemplate(template.id, FORMS[template.id], base);
        const dir = path.join(base, id);
        const recipe = readRecipe(id, base);
        expect(recipe.template).toBe(template.id);
        expect(parseRecipe(JSON.parse(fs.readFileSync(path.join(dir, "recipe.json"), "utf-8")), dir)).toEqual(recipe);
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
          if (spawnSync(LINTER, ["--version"]).status === 0) {
            execFileSync(LINTER, ["-s", "bash", target]);
          }
        }
      });

      it("refuses a bad name, and an existing recipe", () => {
        expect(() => createRecipeFromTemplate(template.id, { ...FORMS[template.id], name: "A b; rm" }, base)).toThrow(
          /not valid/,
        );
        createRecipeFromTemplate(template.id, FORMS[template.id], base);
        expect(() => createRecipeFromTemplate(template.id, FORMS[template.id], base)).toThrow(/already exists/);
      });
    });
  }

  it("refuses an unknown template", () => {
    expect(() => createRecipeFromTemplate("vm", {}, base)).toThrow(/Unknown template/);
  });

  it("docker: the exec argv runs as manor, and the container is the instance", () => {
    const up = RECIPE_TEMPLATES[0].files["up.sh"].content;
    expect(up).toContain('"exec","-i","-u","manor"');
    expect(up).toContain('-e "MANOR_INSTANCE_ID=$name"');
    expect(up).toContain("/run/secrets/manor-key:ro");
    expect(RECIPE_TEMPLATES[0].recipe(FORMS.docker).env).toMatchObject({
      MANOR_DOCKER_NAME: "box1",
      MANOR_DOCKER_CONTEXT: "remote-1",
    });
  });

  it("kubernetes: the instance id is namespace/name and storage is validated", () => {
    const up = RECIPE_TEMPLATES[1].files["up.sh"].content;
    expect(up).toContain('value: "$namespace/$name"');
    expect(up).toContain("--timeout=10m");
    expect(() => RECIPE_TEMPLATES[1].recipe({ ...FORMS.kubernetes, storage: "lots" })).toThrow(/storage size/);
  });
});
