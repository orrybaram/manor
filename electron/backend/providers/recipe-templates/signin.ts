/**
 * "Sign new pods in for me", Kubernetes profiles only.
 *
 * Manor writes one Secret per profile, `manor-signin-<profileId>`, in the profile's namespace, with
 * keys `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`. The `kubernetes` template's
 * pod reads it with `envFrom` (optional), and its hooks step runs
 * `gh auth setup-git` when `GH_TOKEN` is set. The laptop keeps no copy: the
 * profile stores only `{ setAt, source }` per token
 * (`HostProfiles.setSignIn`).
 *
 * How a token travels, and why:
 *
 * - **Never in argv.** Any local user can read a process's argv (`ps`), and
 *   argv lands in error messages ("Command failed: kubectl …"). So every
 *   payload that holds a token goes to kubectl on **stdin**: a new Secret
 *   with `create -f -`, a change to an existing one with
 *   `patch --type merge --patch-file /dev/stdin`. (`patch -p <json>` would
 *   put the token in argv.)
 * - **No second copy.** Not `apply`: it saves the whole object, tokens and
 *   all, in the `last-applied-configuration` annotation, which a later
 *   Remove (a patch of `.data`) would leave behind.
 * - **Never on disk.** No temp file: `/dev/stdin` is the pipe Manor writes.
 * - **Never read back.** Merging with what the Secret already holds reads
 *   its key *names* only (a go-template over `.data`), never their values;
 *   a JSON merge patch then changes just the keys being set or removed, so
 *   Manor needn't know the others. (`-o jsonpath={.data}` would print the
 *   values too.)
 * - **Not through the recipe runner.** These run kubectl directly, so the
 *   runner's output capture (the host's start log) never sees them, and any
 *   error message is scrubbed of the token before it is thrown.
 *
 * The trade: anyone who can read Secrets in the namespace,
 * or exec into any of its pods, can read both tokens. Each profile has its own
 * Secret, so removing a token through one never touches another's.
 */

import { execFile } from "node:child_process";
import type { Recipe } from "../recipes";
import type { HostProfile, SignInMeta } from "../../../projects/types";
import type { SignInKind } from "../../../projects/host-profiles";
import { failureLine, probeFailure } from "./checks/deps";
import { CONTEXT_PATTERN, NAME_PATTERN } from "./types";

/**
 * The profile's Secret name: `manor-signin-<profileId>`. The template's
 * `envFrom` names it through `MANOR_K8S_SIGNIN_SECRET`. A profile id is `hp-`
 * plus hex, so the name is a valid DNS name; anything else is refused.
 */
export function signInSecretName(profileId: string): string {
  if (!/^hp-[0-9a-f]+$/.test(profileId)) throw new Error("The profile's id is not valid.");
  const name = `manor-signin-${profileId}`;
  if (name.length > 253) throw new Error("The profile's id is too long.");
  return name;
}

/** Which Secret key holds each token. */
export const SIGNIN_KEYS: Readonly<Record<SignInKind, string>> = {
  github: "GH_TOKEN",
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
};

/** What the profile editor sends: where the GitHub token comes from, and the pasted Claude one. */
export interface SignInInput {
  github?: { source: "gh" } | { source: "pasted"; token: string };
  claude?: { token: string };
}

/** Where a profile's Secret lives. */
export interface KubeTarget {
  context: string;
  namespace: string;
  /** The profile's Secret. */
  secret: string;
}

/** How long one kubectl or gh call may take. */
const RUN_TIMEOUT_MS = 30_000;

/** A token: printable ASCII with no spaces, as `gh` and `claude setup-token` print them. */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export interface SignInDeps {
  /**
   * Run `file` with `args` without a shell (on the login PATH the app
   * already uses), writing `input`, if given, to its stdin; resolve with its
   * stdout. Rejects like `CheckDeps.execFile`: the error carries `code`,
   * `stdout` and `stderr`.
   */
  run: (file: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<string>;
  /** Absent means `Date.now`. */
  now?: () => number;
}

export const defaultSignInDeps: SignInDeps = {
  run: (file, args, opts) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        {
          timeout: opts?.timeoutMs ?? RUN_TIMEOUT_MS,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) =>
          err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout),
      );
      // A child that exits before reading its stdin makes the write fail with
      // EPIPE; the exit itself is what we report.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts?.input ?? "");
    }),
};

/**
 * The profile's cluster and namespace, checked with the template's own
 * patterns. Throws for a profile that isn't Kubernetes: Docker profiles have
 * no Secret store that isn't a file on the daemon's disk.
 */
export function profileKubeTarget(profile: HostProfile): KubeTarget {
  if (profile.templateId !== "kubernetes") {
    throw new Error("Signing new pods in is only for Kubernetes profiles.");
  }
  const context = profile.values.context ?? "";
  const namespace = profile.values.namespace?.trim() || "manor";
  if (!CONTEXT_PATTERN.test(context)) throw new Error("The profile's cluster is not valid.");
  if (!NAME_PATTERN.test(namespace)) throw new Error("The profile's namespace is not valid.");
  return { context, namespace, secret: signInSecretName(profile.id) };
}

/**
 * A new sign-in Secret holding `data` (key → plain token), for
 * `kubectl create -f -`. JSON, which is YAML too, so no token can break out of
 * its string.
 */
export function buildSignInSecret(secret: string, namespace: string, data: Record<string, string>): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secret,
      namespace,
      labels: { "app.kubernetes.io/managed-by": "manor" },
    },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "utf-8").toString("base64")]),
    ),
  });
}

/**
 * A JSON merge patch of the Secret's `data`: a string sets a key (base64'd
 * here), `null` removes it. Keys not named are left as they are.
 */
export function buildSignInPatch(changes: Record<string, string | null>): string {
  return JSON.stringify({
    data: Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [
        key,
        value === null ? null : Buffer.from(value, "utf-8").toString("base64"),
      ]),
    ),
  });
}

function kubectlBase(target: KubeTarget): string[] {
  return ["--context", target.context, "-n", target.namespace];
}

/** An error saying what kubectl or gh said, with every secret in `secrets` blanked out. */
function runError(what: string, err: unknown, secrets: readonly string[]): Error {
  const failure = probeFailure(err);
  let detail =
    failure.kind === "missing"
      ? "it was not found on PATH"
      : failure.kind === "timeout"
        ? "it took too long"
        : failureLine(failure.output) || "it failed";
  for (const secret of secrets) {
    if (secret === "") continue;
    for (const form of [secret, Buffer.from(secret, "utf-8").toString("base64")]) {
      detail = detail.split(form).join("[redacted]");
    }
  }
  return new Error(`${what}: ${detail}`);
}

function isNotFound(err: unknown): boolean {
  const failure = probeFailure(err);
  return failure.kind === "failed" && /NotFound|not found/i.test(failure.output);
}

/**
 * The key names `manor-signin` holds, or `null` when there is no such
 * Secret. Never the values: a go-template that prints only `.data`'s keys.
 */
export async function signInSecretKeys(target: KubeTarget, deps: SignInDeps): Promise<string[] | null> {
  let out: string;
  try {
    out = await deps.run("kubectl", [
      ...kubectlBase(target),
      "get",
      "secret",
      target.secret,
      "-o",
      'go-template={{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}',
    ]);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw runError("kubectl could not read the sign-in Secret", err, []);
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** This computer's GitHub token, from `gh auth token`. */
async function ghToken(deps: SignInDeps): Promise<string> {
  let out: string;
  try {
    out = await deps.run("gh", ["auth", "token"]);
  } catch (err) {
    // No \`cause\`: whatever gh printed is dropped, as it may hold a token.
    const failure = probeFailure(err);
    if (failure.kind === "missing") {
      // eslint-disable-next-line preserve-caught-error
      throw new Error("The GitHub CLI (gh) was not found on this computer.");
    }
    // eslint-disable-next-line preserve-caught-error
    throw new Error("This computer isn't signed in to GitHub: run `gh auth login`, then try again.");
  }
  return checkedToken(out, "This computer's GitHub token");
}

function checkedToken(raw: string, what: string): string {
  const token = raw.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error(`${what} is empty or not a token.`);
  return token;
}

/** Create the namespace when it is missing, as `up.sh` would. */
async function ensureNamespace(target: KubeTarget, deps: SignInDeps): Promise<void> {
  const base = ["--context", target.context];
  try {
    await deps.run("kubectl", [...base, "get", "namespace", target.namespace]);
    return;
  } catch (err) {
    if (!isNotFound(err)) throw runError("kubectl could not read the namespace", err, []);
  }
  try {
    await deps.run("kubectl", [...base, "create", "namespace", target.namespace]);
  } catch (err) {
    throw runError("kubectl could not create the namespace", err, []);
  }
}

/**
 * Put the tokens in `input` into the profile's `manor-signin` Secret, keeping
 * any other keys it holds, and answer the metadata to save on the profile.
 * Every token reaches kubectl on stdin only.
 */
export async function writeSignIn(
  profile: HostProfile,
  input: SignInInput,
  deps: SignInDeps = defaultSignInDeps,
): Promise<{ github?: SignInMeta; claude?: SignInMeta }> {
  const target = profileKubeTarget(profile);
  const tokens: Record<string, string> = {};
  const meta: { github?: SignInMeta; claude?: SignInMeta } = {};
  const now = (deps.now ?? Date.now)();
  if (input.github) {
    tokens[SIGNIN_KEYS.github] =
      input.github.source === "gh"
        ? await ghToken(deps)
        : checkedToken(input.github.token, "The GitHub token");
    meta.github = { setAt: now, source: input.github.source };
  }
  if (input.claude) {
    tokens[SIGNIN_KEYS.claude] = checkedToken(input.claude.token, "The Claude token");
    meta.claude = { setAt: now, source: "pasted" };
  }
  if (Object.keys(tokens).length === 0) throw new Error("Nothing to sign in with.");
  const secrets = Object.values(tokens);

  const existing = await signInSecretKeys(target, deps);
  if (existing === null) await ensureNamespace(target, deps);
  try {
    if (existing === null) {
      await deps.run("kubectl", [...kubectlBase(target), "create", "-f", "-"], {
        input: buildSignInSecret(target.secret, target.namespace, tokens),
      });
    } else {
      await deps.run(
        "kubectl",
        [...kubectlBase(target), "patch", "secret", target.secret, "--type", "merge", "--patch-file", "/dev/stdin"],
        { input: buildSignInPatch(tokens) },
      );
    }
  } catch (err) {
    throw runError("kubectl could not write the sign-in Secret", err, secrets);
  }
  return meta;
}

/**
 * Take one token out of the profile's `manor-signin` Secret, deleting the
 * Secret when nothing is left in it. A missing Secret or key is a no-op.
 */
export async function removeSignIn(
  profile: HostProfile,
  which: SignInKind,
  deps: SignInDeps = defaultSignInDeps,
): Promise<void> {
  const target = profileKubeTarget(profile);
  const key = SIGNIN_KEYS[which];
  const existing = await signInSecretKeys(target, deps);
  if (existing === null || !existing.includes(key)) return;
  try {
    if (existing.every((k) => k === key)) {
      await deps.run("kubectl", [...kubectlBase(target), "delete", "secret", target.secret, "--ignore-not-found"]);
    } else {
      await deps.run(
        "kubectl",
        [...kubectlBase(target), "patch", "secret", target.secret, "--type", "merge", "--patch-file", "/dev/stdin"],
        { input: buildSignInPatch({ [key]: null }) },
      );
    }
  } catch (err) {
    throw runError("kubectl could not update the sign-in Secret", err, []);
  }
}

/**
 * Delete the profile's whole `manor-signin` Secret, for when the profile is
 * removed. A missing Secret is fine (`--ignore-not-found`). Throws when the
 * cluster can't be reached, so the caller can keep the profile.
 */
export async function deleteSignInSecret(
  profile: HostProfile,
  deps: SignInDeps = defaultSignInDeps,
): Promise<void> {
  const target = profileKubeTarget(profile);
  try {
    await deps.run("kubectl", [...kubectlBase(target), "delete", "secret", target.secret, "--ignore-not-found"]);
  } catch (err) {
    throw runError("kubectl could not delete the sign-in Secret", err, []);
  }
}

/** One host of the profile: its id and its recipe. */
export interface ProfileHost {
  hostId: string;
  recipe: Recipe;
}

/**
 * Delete the pod of each host given that is running, so its StatefulSet
 * recreates it and it reads the Secret anew. A stopped host has no pod and
 * is skipped (`--ignore-not-found`). Each host's own recipe says where its
 * pod is: a profile edited since may name another namespace. Answers the
 * ids of the hosts whose pod was deleted.
 */
export async function restartPods(
  hosts: readonly ProfileHost[],
  deps: SignInDeps = defaultSignInDeps,
): Promise<string[]> {
  const restarted: string[] = [];
  for (const { hostId, recipe } of hosts) {
    if (recipe.template !== "kubernetes") continue;
    const env = recipe.env ?? {};
    const name = env.MANOR_K8S_NAME ?? "";
    const namespace = env.MANOR_K8S_NAMESPACE ?? "";
    const context = env.MANOR_K8S_CONTEXT ?? "";
    if (!NAME_PATTERN.test(name) || !NAME_PATTERN.test(namespace)) continue;
    if (context !== "" && !CONTEXT_PATTERN.test(context)) continue;
    const args = [
      ...(context !== "" ? ["--context", context] : []),
      "-n",
      namespace,
      "delete",
      "pod",
      `${name}-0`,
      "--ignore-not-found",
      "--wait=false",
    ];
    let out: string;
    try {
      out = await deps.run("kubectl", args);
    } catch (err) {
      throw runError(`kubectl could not restart ${recipe.name}'s pod`, err, []);
    }
    if (/deleted/.test(out)) restarted.push(hostId);
  }
  return restarted;
}
