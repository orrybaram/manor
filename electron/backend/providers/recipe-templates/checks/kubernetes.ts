/**
 * The `kubernetes` template's checks (ADR-234 D6). For now only its
 * choices: kubeconfig's contexts, each with its cluster's server so two
 * contexts can be told apart, and kubectl's current one labelled as such.
 * A missing CLI or a broken kubeconfig lists none. The form starts on the
 * context the newest existing Kubernetes recipe uses (if still listed),
 * never on kubectl's current one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hostRecipesDir } from "../../../../paths";
import type { Choice, TemplateCheckResult } from "../types";
import type { CheckDeps } from "./deps";

interface KubeConfigView {
  "current-context"?: unknown;
  contexts?: unknown;
  clusters?: unknown;
}

interface Named<T> {
  name?: unknown;
  context?: T;
  cluster?: T;
}

function namedList<T>(list: unknown): Array<Named<T>> {
  return Array.isArray(list)
    ? list.filter((item): item is Named<T> => typeof item === "object" && item !== null)
    : [];
}

/** The contexts in `kubectl config view -o json`'s output. */
export function parseKubeContexts(stdout: string): Choice[] {
  let view: KubeConfigView;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return [];
    view = parsed as KubeConfigView;
  } catch {
    return [];
  }
  const servers = new Map<string, string>();
  for (const { name, cluster } of namedList<{ server?: unknown }>(view.clusters)) {
    if (typeof name === "string" && typeof cluster?.server === "string") {
      servers.set(name, cluster.server);
    }
  }
  const current = view["current-context"];
  return namedList<{ cluster?: unknown }>(view.contexts).flatMap((ctx): Choice[] => {
    if (typeof ctx.name !== "string" || ctx.name === "") return [];
    const cluster = ctx.context?.cluster;
    const server = typeof cluster === "string" ? servers.get(cluster) : undefined;
    return [
      {
        value: ctx.name,
        label: ctx.name === current ? `${ctx.name} · kubectl's current` : ctx.name,
        ...(server ? { hint: server } : {}),
      },
    ];
  });
}

async function kubeContexts(deps: CheckDeps): Promise<Choice[]> {
  try {
    return parseKubeContexts(await deps.execFile("kubectl", ["config", "view", "-o", "json"]));
  } catch {
    return [];
  }
}

/**
 * The context of the most recently written `kubernetes` recipe in
 * `baseDir` (by `recipe.json`'s mtime) that has one, or undefined.
 */
export function lastUsedContext(baseDir: string, listed: Set<string>): string | undefined {
  let ids: string[];
  try {
    ids = fs.readdirSync(baseDir);
  } catch {
    return undefined;
  }
  const found: Array<{ context: string; mtime: number }> = [];
  for (const id of ids) {
    const file = path.join(baseDir, id, "recipe.json");
    try {
      const recipe: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (typeof recipe !== "object" || recipe === null) continue;
      const { template, env } = recipe as { template?: unknown; env?: unknown };
      if (template !== "kubernetes" || typeof env !== "object" || env === null) continue;
      const context = (env as Record<string, unknown>).MANOR_K8S_CONTEXT;
      if (typeof context !== "string" || !listed.has(context)) continue;
      found.push({ context, mtime: fs.statSync(file).mtimeMs });
    } catch {
      continue;
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.context;
}

export async function check(
  _values: Record<string, string>,
  deps: CheckDeps,
): Promise<TemplateCheckResult> {
  const contexts = await kubeContexts(deps);
  const last = lastUsedContext(deps.recipesDir ?? hostRecipesDir(), new Set(contexts.map((c) => c.value)));
  return {
    checks: [],
    choices: { context: contexts },
    ...(last !== undefined ? { defaults: { context: last } } : {}),
  };
}
