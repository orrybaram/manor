/**
 * The `kubernetes` template's checks.
 *
 * Choices: kubeconfig's contexts, each with its cluster's server so two
 * contexts can be told apart, and kubectl's current one labelled as such. A
 * missing CLI or a broken kubeconfig lists none. The form starts on the
 * context the newest existing Kubernetes recipe uses (if still listed),
 * never on kubectl's current one. When permissions or storage fall short,
 * also the namespaces that would work and the storage classes there are.
 *
 * Checklist, in order (a check after one that isn't `ok` is `todo`): kubectl
 * is on PATH, the chosen cluster answers (naming a missing sign-in helper),
 * you may create what the recipe creates in the namespace, and there is a
 * storage class for the disk. Fixes are links and field settings only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hostRecipesDir } from "../../../../paths";
import type { Choice, TemplateCheck, TemplateCheckResult } from "../types";
import { failureLine, firstLine, probeFailure, seconds, type CheckDeps, type ProbeFailure } from "./deps";

const INSTALL_KUBECTL_URL = "https://kubernetes.io/docs/tasks/tools/";

/** Where to get the exec credential helpers clusters commonly name. */
const HELPER_URLS: Record<string, string> = {
  "gke-gcloud-auth-plugin":
    "https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin",
  gcloud: "https://cloud.google.com/sdk/docs/install",
  aws: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
  "aws-iam-authenticator": "https://docs.aws.amazon.com/eks/latest/userguide/install-aws-iam-authenticator.html",
  kubelogin: "https://azure.github.io/kubelogin/install.html",
  doctl: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
};

/** The namespace the template's field defaults to. */
const DEFAULT_NAMESPACE = "manor";

/** At most this many other namespaces are tried when looking for one that works. */
const MAX_NAMESPACES_TRIED = 10;

/** What the recipe creates inside its namespace, and how to say it. */
const NAMESPACED: ReadonlyArray<{ resource: string; what: string }> = [
  { resource: "statefulsets", what: "StatefulSets" },
  { resource: "secrets", what: "Secrets" },
  { resource: "persistentvolumeclaims", what: "volume claims" },
  { resource: "pods/exec", what: "exec into pods" },
];

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

function todo(id: string, title: string): TemplateCheck {
  return { id, state: "todo", title };
}

function timedOut(id: string): TemplateCheck {
  return { id, state: "bad", title: `The cluster didn't answer within ${seconds()}` };
}

/** "a, b and c". */
function listing(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

async function cliCheck(deps: CheckDeps): Promise<TemplateCheck> {
  const id = "kubectl-cli";
  try {
    const out = await deps.execFile("kubectl", ["version", "--client", "-o", "json"]);
    let version: string | undefined;
    try {
      const parsed = JSON.parse(out) as { clientVersion?: { gitVersion?: unknown } };
      if (typeof parsed.clientVersion?.gitVersion === "string") version = `kubectl ${parsed.clientVersion.gitVersion}`;
    } catch {
      // Installed all the same.
    }
    return { id, state: "ok", title: "kubectl is installed", ...(version ? { detail: version } : {}) };
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "missing") {
      return {
        id,
        state: "bad",
        title: "kubectl isn't installed",
        detail: "Manor uses the kubectl command to talk to your cluster.",
        fix: { kind: "url", label: "Install kubectl", href: INSTALL_KUBECTL_URL },
      };
    }
    if (failure.kind === "timeout") return { id, state: "bad", title: `kubectl didn't answer within ${seconds()}` };
    return { id, state: "bad", title: "kubectl isn't working", detail: firstLine(failure.output) || undefined };
  }
}

/** The exec credential helper a kubectl error says is missing, if that is what it says. */
export function missingHelper(output: string): string | undefined {
  const m = /executable\s+["']?([^\s"']+?)["']?\s+not found/i.exec(output);
  return m ? m[1] : undefined;
}

async function clusterCheck(context: string, deps: CheckDeps): Promise<TemplateCheck> {
  const id = "k8s-cluster";
  if (context === "") {
    return { id, state: "bad", title: "Choose a cluster", detail: "Pick the kubectl context Manor should deploy to." };
  }
  try {
    const out = await deps.execFile("kubectl", ["--context", context, "version", "-o", "json"]);
    let version: string | undefined;
    try {
      const parsed = JSON.parse(out) as { serverVersion?: { gitVersion?: unknown } };
      if (typeof parsed.serverVersion?.gitVersion === "string") version = parsed.serverVersion.gitVersion;
    } catch {
      // It answered all the same.
    }
    return {
      id,
      state: "ok",
      title: "The cluster answers",
      detail: version ? `${context} · Kubernetes ${version}` : context,
    };
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "timeout") return timedOut(id);
    if (failure.kind === "missing") return { id, state: "bad", title: "kubectl isn't installed" };
    const helper = missingHelper(failure.output);
    if (helper) {
      const href = HELPER_URLS[helper];
      return {
        id,
        state: "bad",
        title: `The ${helper} sign-in helper isn't installed`,
        detail: `kubectl needs ${helper} to sign in to ${context}. Install it, then this updates on its own.`,
        ...(href ? { fix: { kind: "url" as const, label: `Get ${helper}`, href } } : {}),
      };
    }
    if (/context was not found|context "[^"]*" does not exist|no context exists/i.test(failure.output)) {
      return {
        id,
        state: "bad",
        title: `kubectl has no cluster called ${context}`,
        detail: "Pick another cluster.",
      };
    }
    if (/unauthorized|must be logged in|credentials/i.test(failure.output)) {
      return {
        id,
        state: "bad",
        title: "The cluster doesn't accept your sign-in",
        detail: failureLine(failure.output) || undefined,
      };
    }
    return {
      id,
      state: "bad",
      title: "The cluster isn't answering",
      detail: failureLine(failure.output) || undefined,
    };
  }
}

type Answer = boolean | ProbeFailure;

/** `kubectl auth can-i create <resource>`: true, false (it exits 1 on "no"), or why it couldn't say. */
async function canCreate(
  context: string,
  resource: string,
  namespace: string | undefined,
  deps: CheckDeps,
): Promise<Answer> {
  const args = ["--context", context, "auth", "can-i", "create", resource];
  if (namespace !== undefined) args.push("-n", namespace);
  try {
    return (await deps.execFile("kubectl", args)).trim().startsWith("yes");
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "failed" && /^no\b/.test(failure.stdout.trim())) return false;
    return failure;
  }
}

/** Whether namespace `ns` exists (as far as you may see). */
async function namespaceExists(context: string, ns: string, deps: CheckDeps): Promise<Answer> {
  try {
    await deps.execFile("kubectl", ["--context", context, "get", "namespace", ns, "-o", "name"]);
    return true;
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "failed" && /not ?found|forbidden/i.test(failure.output)) return false;
    return failure;
  }
}

/** Every namespaced create the recipe needs, in `ns`: the ones refused, or why it couldn't say. */
async function refusedIn(context: string, ns: string, deps: CheckDeps): Promise<string[] | ProbeFailure> {
  const answers = await Promise.all(NAMESPACED.map(({ resource }) => canCreate(context, resource, ns, deps)));
  const failure = answers.find((a): a is ProbeFailure => typeof a !== "boolean");
  if (failure) return failure;
  return NAMESPACED.filter((_, i) => answers[i] === false).map(({ what }) => what);
}

/** Run `work` over `items`, `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

/**
 * The other namespaces where every create passes, when there are few enough
 * to try (`MAX_NAMESPACES_TRIED`); none when they can't be listed.
 */
async function workingNamespaces(context: string, except: string, deps: CheckDeps): Promise<string[]> {
  let names: string[];
  try {
    const out = await deps.execFile("kubectl", [
      "--context",
      context,
      "get",
      "namespaces",
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    names = out.split(/\s+/).filter((n) => n !== "" && n !== except);
  } catch {
    return [];
  }
  if (names.length === 0 || names.length > MAX_NAMESPACES_TRIED) return [];
  const refused = await mapLimit(names, 3, (ns) => refusedIn(context, ns, deps));
  return names.filter((_, i) => {
    const r = refused[i];
    return Array.isArray(r) && r.length === 0;
  });
}

async function permissionsCheck(
  context: string,
  ns: string,
  deps: CheckDeps,
): Promise<{ check: TemplateCheck; namespaces?: Choice[] }> {
  const id = "k8s-permissions";
  const [refused, exists, mayCreateNs] = await Promise.all([
    refusedIn(context, ns, deps),
    namespaceExists(context, ns, deps),
    canCreate(context, "namespaces", undefined, deps),
  ]);
  const failure = [refused, exists, mayCreateNs].find(
    (a): a is ProbeFailure => typeof a === "object" && !Array.isArray(a),
  );
  if (failure) {
    if (failure.kind === "timeout") return { check: timedOut(id) };
    return {
      check: {
        id,
        state: "bad",
        title: "Manor couldn't check your permissions",
        detail: failure.kind === "failed" ? failureLine(failure.output) || undefined : undefined,
      },
    };
  }
  const missing = [
    ...(exists === false && mayCreateNs === false ? ["create the namespace"] : []),
    ...(refused as string[]).map((what) => (what.startsWith("exec") ? what : `create ${what}`)),
  ];
  if (missing.length === 0) {
    return {
      check: {
        id,
        state: "ok",
        title: `You may deploy to namespace ${ns}`,
        detail: exists ? `Namespace ${ns}` : `Manor will create namespace ${ns}`,
      },
    };
  }
  const working = await workingNamespaces(context, ns, deps);
  const first = working[0];
  const why = `You can't ${listing(missing)} there.`;
  return {
    check: {
      id,
      state: "bad",
      title: `You don't have permission to deploy to namespace ${ns}`,
      detail: first
        ? `${why} ${working.length === 1 ? `Namespace ${first} works.` : `${working.length} other namespaces work.`}`
        : `${why} Ask your cluster admin for a namespace you can use.`,
      ...(first
        ? { fix: { kind: "set" as const, label: `Use namespace ${first}`, key: "namespace", value: first } }
        : {}),
    },
    ...(working.length > 0 ? { namespaces: working.map((n) => ({ value: n, label: n })) } : {}),
  };
}

interface StorageClassItem {
  metadata?: { name?: unknown; annotations?: Record<string, unknown> };
  provisioner?: unknown;
}

/** `kubectl get storageclass -o json`'s classes: name, provisioner, and whether it is the default. */
export function parseStorageClasses(
  stdout: string,
): Array<{ name: string; provisioner?: string; isDefault: boolean }> {
  let items: unknown;
  try {
    items = (JSON.parse(stdout) as { items?: unknown }).items;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const item = raw as StorageClassItem;
    const name = item.metadata?.name;
    if (typeof name !== "string" || name === "") return [];
    const annotations = item.metadata?.annotations ?? {};
    const isDefault =
      annotations["storageclass.kubernetes.io/is-default-class"] === "true" ||
      annotations["storageclass.beta.kubernetes.io/is-default-class"] === "true";
    return [
      { name, isDefault, ...(typeof item.provisioner === "string" ? { provisioner: item.provisioner } : {}) },
    ];
  });
}

async function storageCheck(
  context: string,
  chosen: string,
  deps: CheckDeps,
): Promise<{ check: TemplateCheck; classes?: Choice[] }> {
  const id = "k8s-storage";
  let classes: ReturnType<typeof parseStorageClasses>;
  try {
    classes = parseStorageClasses(
      await deps.execFile("kubectl", ["--context", context, "get", "storageclass", "-o", "json"]),
    );
  } catch (err) {
    const failure = probeFailure(err);
    if (failure.kind === "timeout") return { check: timedOut(id) };
    if (failure.kind === "failed" && /forbidden/i.test(failure.output)) {
      // Namespace-bound users often can't list classes; don't block on it.
      return {
        check: chosen
          ? {
              id,
              state: "ok",
              title: `The disk comes from storage class ${chosen}`,
              detail: "Manor couldn't list storage classes to confirm it exists.",
            }
          : {
              id,
              state: "ok",
              title: "The disk comes from the cluster's default storage class",
              detail: "Manor couldn't list storage classes to confirm there is one.",
            },
      };
    }
    return {
      check: {
        id,
        state: "bad",
        title: "Manor couldn't check the cluster's storage classes",
        detail: failure.kind === "failed" ? failureLine(failure.output) || undefined : undefined,
      },
    };
  }
  const options: Choice[] = classes.map((c) => ({
    value: c.name,
    label: c.isDefault ? `${c.name} · default` : c.name,
    ...(c.provisioner ? { hint: c.provisioner } : {}),
  }));
  const fallback = classes.find((c) => c.isDefault) ?? classes[0];
  if (classes.length === 0) {
    return {
      check: {
        id,
        state: "bad",
        title: "The cluster has no storage classes",
        detail: "The host needs a disk. Ask your cluster admin to set up a storage class.",
      },
    };
  }
  if (chosen) {
    if (classes.some((c) => c.name === chosen)) {
      return { check: { id, state: "ok", title: `The disk comes from storage class ${chosen}` }, classes: options };
    }
    return {
      check: {
        id,
        state: "bad",
        title: `The cluster has no storage class called ${chosen}`,
        detail: "Choose one it has.",
        fix: { kind: "set", label: `Use ${fallback.name}`, key: "storageClass", value: fallback.name },
      },
      classes: options,
    };
  }
  const def = classes.find((c) => c.isDefault);
  if (def) {
    return {
      check: { id, state: "ok", title: "The cluster has a default storage class", detail: def.name },
      classes: options,
    };
  }
  return {
    check: {
      id,
      state: "bad",
      title: "The cluster has no default storage class",
      detail: "Choose which storage class the host's disk comes from.",
      fix: { kind: "set", label: `Use ${fallback.name}`, key: "storageClass", value: fallback.name },
    },
    classes: options,
  };
}

const TITLES = {
  cluster: "The cluster answers",
  permissions: "You may deploy to the namespace",
  storage: "The cluster has a storage class for the disk",
};

/** Server hostnames of the managed clouds' Kubernetes services. */
const CLOUD_SERVER = /(?:\.gke\.|container\.googleapis\.com|googleapis\.com|\.eks\.amazonaws\.com|\.azmk8s\.io|\.k8s\.ondigitalocean\.com)/i;
/** Context names the clouds' own CLIs write: GKE's bare-IP servers show only here. */
const CLOUD_NAME = /^(?:gke_|arn:aws:eks|do-)/i;

/** Whether a context (by its name, and the server it points at) looks like a managed cloud cluster. */
function looksLikeCloud(name: string, server: string | undefined): boolean {
  return CLOUD_NAME.test(name) || (server !== undefined && CLOUD_SERVER.test(server));
}

/** Said of a cloud cluster's disk, which is a paid thing that outlives the pod. */
const DISK_BILLING_NOTE = "The disk keeps billing while the host is stopped.";

async function checklist(
  values: Record<string, string>,
  deps: CheckDeps,
  contexts: Choice[],
): Promise<{ checks: TemplateCheck[]; choices: Record<string, Choice[]> }> {
  const context = (values.context ?? "").trim();
  const ns = (values.namespace ?? "").trim() || DEFAULT_NAMESPACE;
  const storageClass = (values.storageClass ?? "").trim();
  const checks: TemplateCheck[] = [];
  const choices: Record<string, Choice[]> = {};
  const rest = (from: number) =>
    [
      todo("k8s-cluster", TITLES.cluster),
      todo("k8s-permissions", TITLES.permissions),
      todo("k8s-storage", TITLES.storage),
    ].slice(from);

  const cli = await cliCheck(deps);
  checks.push(cli);
  if (cli.state !== "ok") return { checks: [...checks, ...rest(0)], choices };
  const cluster = await clusterCheck(context, deps);
  checks.push(cluster);
  if (cluster.state !== "ok") return { checks: [...checks, ...rest(1)], choices };
  const permissions = await permissionsCheck(context, ns, deps);
  checks.push(permissions.check);
  if (permissions.namespaces) choices.namespace = permissions.namespaces;
  if (permissions.check.state !== "ok") return { checks: [...checks, ...rest(2)], choices };
  const storage = await storageCheck(context, storageClass, deps);
  checks.push(storage.check);
  if (storage.classes) choices.storageClass = storage.classes;
  const chosen = contexts.find((c) => c.value === context);
  if (storage.check.state === "ok" && looksLikeCloud(context, chosen?.hint)) {
    storage.check.detail = [storage.check.detail, DISK_BILLING_NOTE].filter(Boolean).join(" ");
  }
  return { checks, choices };
}

export async function check(
  values: Record<string, string>,
  deps: CheckDeps,
): Promise<TemplateCheckResult> {
  const contexts = await kubeContexts(deps);
  const list = await checklist(values, deps, contexts);
  const last = lastUsedContext(deps.recipesDir ?? hostRecipesDir(), new Set(contexts.map((c) => c.value)));
  return {
    checks: list.checks,
    choices: { ...list.choices, context: contexts },
    ...(last !== undefined ? { defaults: { context: last } } : {}),
  };
}
