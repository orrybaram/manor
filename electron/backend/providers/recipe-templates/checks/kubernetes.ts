/**
 * The `kubernetes` template's checks (ADR-234 D6). For now only its
 * choices: kubeconfig's contexts, each with its cluster's server so two
 * contexts can be told apart, and kubectl's current one labelled as such.
 * A missing CLI or a broken kubeconfig lists none.
 */

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

export async function check(
  _values: Record<string, string>,
  deps: CheckDeps,
): Promise<TemplateCheckResult> {
  return { checks: [], choices: { context: await kubeContexts(deps) } };
}
