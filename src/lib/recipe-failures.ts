/**
 * Plain-sentence summaries for the failures people hit most often when a
 * Docker or Kubernetes host's recipe fails (ADR-234 D10). Pure: it reads the
 * tail of the recipe's output and says what went wrong and, when there is
 * one that edits nothing of the user's, what to do about it. The raw output
 * stays on screen beneath the summary.
 *
 * Actions are deliberately small: open a page, or retry. Rewriting a recipe
 * or removing a container is the user's call.
 */

export type RecipeFailureAction =
  | { kind: "url"; label: string; href: string }
  | { kind: "retry" };

export interface RecipeFailure {
  summary: string;
  action?: RecipeFailureAction;
}

/** Only the end of the output says why it stopped. */
const TAIL_BYTES = 4096;

interface Rule {
  pattern: RegExp;
  /** The summary; `match` is the pattern's match against the tail. */
  summary: (match: RegExpExecArray) => string;
  action?: RecipeFailureAction;
}

const url = (label: string, href: string): RecipeFailureAction => ({ kind: "url", label, href });

/**
 * Docker's own ssh helper, when a remote context's connection fails:
 * `command [ssh … -- build-box docker system dial-stdio] has exited with …`.
 * The capture is the machine's host.
 */
const DOCKER_OVER_SSH = String.raw`\[ssh [^\]\n]*?-- ([^\s\]]+) docker system dial-stdio\]`;

/** More specific rules come first: the first that matches wins. */
const RULES: Rule[] = [
  // Docker on another machine over SSH (ADR-234 D12): before the local
  // rules, which would otherwise say "this computer".
  {
    pattern: new RegExp(String.raw`${DOCKER_OVER_SSH}[^\n]*?(?:exit status 127|docker: (?:command )?not found|command not found: docker)`, "i"),
    summary: (m) => `Docker isn't installed on ${m[1]}.`,
    action: url("How to install Docker Engine", "https://docs.docker.com/engine/install/"),
  },
  {
    pattern: new RegExp(String.raw`${DOCKER_OVER_SSH}[^\n]*?exit status 255`, "i"),
    summary: (m) => `Manor couldn't reach ${m[1]} over SSH.`,
    action: { kind: "retry" },
  },
  {
    pattern: /error during connect[^\n]*ssh: (?:connect to host |Could not resolve hostname )([^\s:]+)/i,
    summary: (m) => `Manor couldn't reach ${m[1]} over SSH.`,
    action: { kind: "retry" },
  },
  // Docker
  {
    pattern: /permission denied while trying to connect to the (?:Docker|docker) daemon socket/i,
    summary: () => "Your user can't use Docker.",
    action: url("Docker's Linux setup steps", "https://docs.docker.com/engine/install/linux-postinstall/"),
  },
  {
    pattern: /Cannot connect to the Docker daemon|Is the docker daemon running/i,
    summary: () => "Docker isn't running. Start it, then retry.",
    action: { kind: "retry" },
  },
  {
    pattern: /docker: command not found|docker CLI was not found/i,
    summary: () => "Docker isn't installed on this computer.",
    action: url("Get Docker Desktop", "https://www.docker.com/products/docker-desktop/"),
  },
  {
    pattern: /no matching manifest for/i,
    summary: () => "The host image wasn't built for this machine's CPU.",
    action: { kind: "retry" },
  },
  {
    pattern: /pull access denied|manifest unknown|repository does not exist/i,
    summary: () => "Docker couldn't download Manor's host image.",
    action: { kind: "retry" },
  },
  {
    pattern: /container name "?\/?([\w.-]+)"? is already in use/i,
    summary: (m) => `A container called ${m[1]} already exists.`,
  },
  {
    pattern: /no space left on device/i,
    summary: () => "Docker is out of disk space.",
    action: url("Docker's guide to freeing space", "https://docs.docker.com/engine/manage-resources/pruning/"),
  },
  {
    pattern: /mounts denied/i,
    summary: () => "Docker can't read a folder Manor shared with it.",
  },
  // Kubernetes
  {
    pattern: /kubectl was not found|kubectl: command not found/i,
    summary: () => "Manor needs kubectl to talk to the cluster.",
    action: url("Install kubectl", "https://kubernetes.io/docs/tasks/tools/"),
  },
  {
    pattern: /executable (\S+) not found/i,
    summary: (m) => `This cluster signs in through ${m[1]}, and Manor can't find it.`,
  },
  {
    pattern: /violates PodSecurity/i,
    summary: () => "This namespace only allows locked-down pods.",
  },
  {
    pattern: /\bforbidden\b/i,
    summary: () => "Your account isn't allowed to do that on this cluster.",
  },
  {
    pattern: /Insufficient (?:cpu|memory)/i,
    summary: () => "No computer in the cluster has room for this host. Try a smaller size.",
  },
  {
    pattern: /ErrImagePull|ImagePullBackOff/i,
    summary: () => "The cluster couldn't download the host image.",
  },
  {
    pattern: /OOMKilled/i,
    summary: () => "The host ran out of memory. Try a larger size.",
  },
  {
    pattern: /storageclass\.storage\.k8s\.io .* not found|ProvisioningFailed|unbound immediate PersistentVolumeClaims/i,
    summary: () => "The cluster couldn't give this host a disk.",
  },
  {
    pattern: /wasn't ready after (\d+) minutes(?:; it was stuck at: ([^\n]+))?/i,
    summary: (m) =>
      `The host didn't start in ${m[1]} minutes.${m[2] ? ` It was stuck at: ${m[2].trim().replace(/\.$/, "")}.` : ""}`,
  },
];

/**
 * A plain sentence for a failed recipe's `output`, with an action when one
 * helps, or null when nothing here recognises it.
 */
export function classifyRecipeFailure(output: string): RecipeFailure | null {
  const tail = output.slice(-TAIL_BYTES);
  for (const rule of RULES) {
    const match = rule.pattern.exec(tail);
    if (match) return { summary: rule.summary(match), ...(rule.action ? { action: rule.action } : {}) };
  }
  return null;
}
