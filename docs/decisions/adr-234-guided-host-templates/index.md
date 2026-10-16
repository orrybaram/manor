---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-234: Guided host templates — Docker and Kubernetes for people who know neither

## Context

ADR-229 D8 shipped two bundled recipe templates, `docker` and `kubernetes`
(`electron/backend/providers/recipe-templates/`), behind Add a host → "Start a
new host" (ADR-233 D4: `AddHostDialog.tsx` + `StartHostForm.tsx`). They work
for someone who already knows Docker or Kubernetes and has a source checkout.
For anyone else they don't work at all. Two proposal pages from the design
session trace where a newcomer gets stuck (Docker:
claude.ai/artifact/9EXjWTo2uMdATdgGWHNKfr, Kubernetes:
claude.ai/artifact/D6vZTyAShPruSrSCxLiFae). Verified against the code:

**Blocking for everyone who downloaded the app**

- Both templates default to image `manor-host:local` (`docker.ts`,
  `kubernetes.ts`). That image only exists after
  `docker build -t manor-host:local docker/host-image`, which needs a source
  checkout: `docker/host-image` is not in the electron-builder `files`, and
  `.github/workflows/release.yml` (a single `macos-latest` job) publishes no
  image. `up` fails with "pull access denied for manor-host". The repo is
  public; nothing is on GHCR.

**Docker template**

- The secret key (ADR-229 D5) is generated into the recipe dir and
  bind-mounted: `-v "$key_file:/run/secrets/manor-key:ro"`. A remote Docker
  context resolves that path on the remote disk (the container gets an empty
  directory), and colima / Rancher Desktop can refuse it ("mounts denied").
  The context field's hint already admits "Must be a daemon on this computer".
- No agent CLIs: the Dockerfile has them as commented-out `RUN` lines, so a
  host connects and `claude` is not found.

**Kubernetes template**

- A blank context means kubectl's *current* context. The field is optional,
  so a work kubeconfig pointed at production gets a host deployed into it
  without being asked.
- The pod spec sets `runAsUser`/`fsGroup` only: no `runAsNonRoot`,
  `allowPrivilegeEscalation: false`, dropped capabilities or seccomp profile,
  so namespaces enforcing Pod Security "restricted" reject it.
- No CPU or memory requests: the pod can land on a tiny node and the
  first-connect node-pty compile gets OOM-killed.
- `rollout status --timeout=10m` waits ten silent minutes when the claim is
  Pending (no default StorageClass), the pod is Unschedulable, or the image
  can't be pulled, then fails with no reason.

**The wizard**

- The Connect step is a flat form of every template field (`Image`, `Docker
  context`, `Namespace`, `Storage class`, `20Gi`), all shown up front, with
  nothing checked before Start.
- A failed recipe surfaces as the `recipe` failure reason in
  `src/lib/host-status.ts` ("The host's recipe failed. Its output is below.")
  plus the raw output (`HostRawOutput`, commit 2aca338b). Nothing turns
  "Cannot connect to the Docker daemon" into "Docker isn't running".
- The first connect is slow (bootstrap compiles node-pty, minutes) and only
  reports the bootstrap's own phase messages.

What already exists and is reused:

- `electron/login-path.ts` already resolves the login-shell PATH for the
  packaged app, and `recipe-runner.ts` spawns with `process.env`, so cloud
  login helpers (`gke-gcloud-auth-plugin`, `aws`) resolve. The Kubernetes
  page's "Login PATH" item is **already done**; this ADR only adds a check
  row that names the missing helper when it still isn't found.
- A recipe's stderr lines already stream as the host's progress
  (`recipe-provider.ts` `onProgress` → `host.progress` → the status detail),
  and bootstrap reports `BootstrapPhase` messages. Named stages build on
  these instead of a new channel.
- Templates already own their fields, scripts and validation (`types.ts`
  `RecipeTemplate`); recipes written from them are plain files the user owns.
  Recipes written before this ADR keep their own scripts and keep working.

## Decision

Four slices, in this order. Each slice ships on its own and leaves the
templates better than before.

### Slice 1 — A published host image

**D1. Release publishes a multi-arch host image to GHCR.** A new
`host-image` job in `release.yml`, on `ubuntu-latest`, with
`permissions: packages: write`: `docker/setup-buildx-action`,
`docker/login-action` with `GITHUB_TOKEN`, `docker/build-push-action` for
`linux/amd64,linux/arm64` from `docker/host-image`, pushing
`ghcr.io/orrybaram/manor-host:<version>` (version from the tag, same as the
app) and `:latest`. It runs in parallel with the macOS `release` job;
`Publish release` waits on both, so a release never names an image that
doesn't exist. arm64 builds under QEMU (the image is apt + useradd, no
compile; minutes, not an hour). The package is made public once by hand
after the first push (GHCR packages start private): a step in the
workflow's header comment says so.

**D2. Templates default to the published image, pinned to the app version.**
The default becomes `ghcr.io/orrybaram/manor-host:<appVersion>` for both
templates, computed when the form is described (the same version the host
tarball pins). The image holds no Manor code (the first connect installs
`manor-host` onto the volume, ADR-229 D6), so the pin only fixes the
toolchain a new host starts with; existing recipes keep the image in their
`recipe.json`.

**D3. `up.sh` pulls a missing image itself, with a stage line.** Docker:
`docker image inspect` first, `docker pull` when missing, so the pull is a
named step and not buried in `docker run`'s output. Kubernetes needs nothing:
the node pulls. The Dockerfile is also shipped as an electron-builder
`extraResources` entry (`host-image/`), and the checks (D9) offer "Build it on
this computer instead" only when a pull fails for a reason other than the
network being down.

### Slice 2 — Template fixes

**D4. Docker: the key lives in a named volume on the daemon.** `up.sh`
creates `manor-$name-key` and fills it once, using the host image itself so
nothing else is pulled:

```sh
docker volume create "manor-$name-key"
docker run --rm -u 0 --entrypoint sh -v "manor-$name-key:/k" "$image" -c \
  'test -s /k/secret.key || (umask 077; head -c 32 /dev/urandom >/k/secret.key; chown 1000:1000 /k/secret.key; chmod 400 /k/secret.key)'
# then: -v "manor-$name-key:/run/secrets/manor:ro" -e MANOR_SECRET_KEY_FILE=/run/secrets/manor/secret.key
```

`--entrypoint sh` because the image's entrypoint waits for `manor-host`;
`-u 0` because a fresh named volume is root-owned. `destroy.sh` removes the
volume; no file is written to the recipe dir. Trust model: the key lives
wherever the daemon lives, separate from the home volume — the same as the
Kubernetes Secret. Nothing is bind-mounted, so remote contexts and colima /
Rancher work. The context field drops its "must be on this computer" hint.

**D5. Kubernetes: a required cluster, a hardened pod, sizes.**

- The `context` field becomes required and a choice, listed from
  `kubectl config get-contexts` with each cluster's server shown so they can
  be told apart. The current context is labelled "kubectl's current" but
  never preselected; the context last used by a Kubernetes recipe is. The
  scripts always pass `--context`. (Recipes without `MANOR_K8S_CONTEXT`
  keep today's behaviour; only new ones are required to have it.)
- Pod and container `securityContext`: `runAsNonRoot: true`, `runAsUser:
  1000`, `runAsGroup: 1000`, `fsGroup: 1000`, `seccompProfile: {type:
  RuntimeDefault}`, `allowPrivilegeEscalation: false`, `capabilities: {drop:
  [ALL]}`. Passes Pod Security "restricted".
- A `size` field: Small (1 CPU, 2 GiB), Medium (2 CPU, 4 GiB, default),
  Large (4 CPU, 8 GiB), written to `MANOR_K8S_CPU` / `MANOR_K8S_MEMORY` and
  rendered as `requests` for both plus a `limits.memory` equal to the request
  (no CPU limit, so the compile isn't throttled).

**D6. Fields gain a type, choices and an "advanced" flag.** `FormField` gets
`type?: "text" | "choice" | "size"` and `advanced?: boolean`. Choices come
from main, not the template file, through one new local-only IPC,
`hosts.checkTemplate(templateId, values) → { checks: TemplateCheck[],
choices: Record<fieldKey, Choice[]> }` (`Choice = { value, label, hint? }`).
Slice 2 fills only `choices` (kubectl contexts, docker contexts); slice 3
fills `checks`. One seam, one round trip per refresh. Probes run in main
with `execFile` (login PATH) and short timeouts, in a new
`recipe-templates/checks/` module per template.

### Slice 3 — A guided Connect step

**D7. The Connect step is a readiness checklist, then Start.** For a template,
`StartHostForm` shows: the non-advanced fields (Docker: none; Kubernetes:
cluster, size), the checklist, an "Advanced" disclosure holding the rest
(name, image, context, namespace, disk, storage class) with their defaults,
and Start — disabled until every check is `ok`. The form re-runs
`checkTemplate` when the window regains focus, when a field changes
(debounced), and every 2 s while any check is `busy`.

**D8. A check is a row with at most one fix.**

```ts
type TemplateCheck = {
  id: string;
  state: "ok" | "bad" | "todo" | "busy";
  title: string;          // plain sentence: "Docker isn't running"
  detail?: string;        // "Context desktop-linux", "280 of 450 MB"
  fix?: { id: string; label: string };   // "Open Docker", "Get it"
};
```

`hosts.runTemplateFix(templateId, fixId, values)` runs it in main. Fix kinds
in v1: open a URL (Get Docker Desktop, install kubectl), open an app (`open
-a Docker` on macOS; `systemctl --user start docker-desktop` on Linux),
start a background job whose progress the next `checkTemplate` reports
(pull the image), and set a field (pick a storage class / namespace /
Small) — the last is applied by the renderer, no IPC. A shell command is
only ever the `detail`, never the action.

Checks, in order (later ones are `todo` until earlier ones pass):

- **Docker:** CLI on PATH → daemon answers (`docker info`, version, context)
  → image present on that daemon (or pulling, with progress).
- **Kubernetes:** kubectl on PATH → the chosen cluster answers (`kubectl
  --context X version` / `/readyz`; a missing exec credential helper is named
  as such) → `kubectl auth can-i` for namespaces (or the namespace exists),
  StatefulSets, Secrets, PVCs and `pods/exec` (fix: choose a namespace where
  all pass) → a default StorageClass exists (fix: choose one).

**D9. Named startup stages.** Template scripts print `manor-stage: <text>` on
stderr at each stage ("Getting Manor's host image", "Creating the
container", "Getting a disk", "Finding room on the cluster", "Downloading the
image on the node"). `recipe-provider.ts` shows the latest stage line as the
host's progress instead of the latest raw line (raw lines still go to the
output). Bootstrap's `install` phase message on a Linux host without node-pty
prebuilds becomes "Installing Manor — building terminal support, this only
happens once (about 2 minutes)". Kubernetes replaces `rollout status
--timeout=10m` with a loop that reads the claim's and pod's state and events
every few seconds, prints the stage, and fails fast with the event's reason
on `ProvisioningFailed`, Pending claim > 60 s with no provisioner,
`FailedScheduling` (Insufficient cpu/memory), `ErrImagePull` /
`ImagePullBackOff`, `CreateContainerConfigError` and Forbidden.

**D10. Common recipe failures read as a sentence.** A pure
`src/lib/recipe-failures.ts` classifies the tail of a failed recipe's output
into `{ summary, action? }`; `host-status.ts` uses it for the `recipe`
summary when it matches, else today's copy. The raw output stays, expanded,
beneath. Patterns from the proposal tables: docker not found, daemon not
running, pull access denied / manifest unknown, name already in use, no
space left, mounts denied, permission denied on the socket, no matching
manifest; kubectl not found, exec plugin not found, Forbidden,
PodSecurity violation, Insufficient cpu/memory, ImagePullBackOff, OOMKilled,
unbound claim. Actions in v1 are only ones that need no recipe rewrite: Retry,
open a URL, Show recipe folder. ("Use Small" / "Remove the old container"
are deferred: they edit or delete the user's things.)

**D11. Agent CLIs install onto the home volume.** The
Connect step has "Agents to install": Claude Code (on by default), Codex.
The choice is written as `MANOR_AGENTS=claude,codex` in `recipe.json`. After
the container / pod is up, `up.sh` installs each missing one as the `manor`
user onto the home volume (`npm i -g --prefix ~/.local …`; the image sets
`ENV PATH=/home/manor/.local/bin:$PATH` so `docker exec` sees it) and skips it when already present, so it runs
once and survives restarts and image upgrades. The image stays agent-free
(small, no stale agent versions baked in, the user's own updates stick).

### Slice 4 — Extras

**D12. Remote Docker over SSH.** The Docker Connect step asks "Run it on: This
computer / Another machine over SSH" with an SSH target. Manor creates (or
reuses) a docker context `manor-<host>` with `docker context create
manor-<host> --docker host=ssh://<target>`, stores it as the recipe's
context, and prepends rows to the checklist: the target answers over SSH
(reusing the SSH path's auth and host-key checks), Docker runs there, the
user may use it (docker group). The image is pulled on the remote daemon for
its own architecture (D1's multi-arch makes this work). Existing contexts
appear as choices under Advanced. The Where step's copy says when plain
"A machine I can SSH into" is the simpler answer.

**D13. "Where's your cluster?" and the disk cost note.** When `kubectl config
get-contexts` lists nothing, the Kubernetes Connect step shows three cards
instead of the form: "I already have a cluster" (paste / point at a
kubeconfig), "A cloud cluster" (short GKE Autopilot and DigitalOcean guides,
linked out), "A practice cluster on this computer" (Docker Desktop / OrbStack
toggle, with a note that the Docker template is simpler here). Main watches
`$KUBECONFIG` / `~/.kube/config` while that step is open and moves on when a
context appears. The disk check's detail and the host row of a Kubernetes
host on a cloud cluster say "the disk keeps billing while the host is
stopped".

**Out of this ADR**: "How many" (one form → N hosts; its own ADR later),
k3s-over-SSH, and failure actions that edit or delete the user's things
("Use Small", "Remove the old container").

## Resolved questions (signed off 2026-10-15)

- **Q1. Image.** Public `ghcr.io/orrybaram/manor-host`, tagged `<version>`
  and `latest`; templates default to `<version>`.
- **Q2. Agent CLIs.** Installed onto the home volume by `up.sh`, opt-in per
  agent, Claude Code on by default (D11). Not baked into the image.
- **Q3. "How many".** Not in this ADR; its own ADR after this ships.
- **Q4. k3s over SSH.** Out of scope; remote Docker (D12) covers one machine.
- **Q5. Dockerfile fallback.** Shipped as `extraResources`, offered only as a
  fix after a failed pull (D3).
- **Q6. Sizes.** CPU and memory requests plus a memory limit equal to the
  request; no CPU limit (D5).
- **Q7. Slice 4.** Both stay: remote Docker (D12), then cluster guides and
  the cost note (D13) last.
- **Q8. Destructive fixes.** Deferred; v1 failure actions are Retry, open a
  URL, Show recipe folder (D10).

## Consequences

**Better**

- A user of the downloaded app can start a Docker or Kubernetes host with no
  source checkout, on amd64 or arm64.
- Docker hosts work on colima, Rancher and remote daemons; Kubernetes hosts
  work in restricted namespaces and can't be deployed to the wrong cluster
  by accident.
- Most failures are caught before Start, with a button; the rest arrive as a
  sentence, with the raw output still there.

**Harder / risks**

- Release gains a Linux job and GHCR as a dependency. A failed image push
  blocks the release (on purpose). The first push needs a manual "make
  public" step.
- The image tag is pinned per version, so every release pushes an image
  (~450 MB compressed layers shared; only changed layers upload).
- `checkTemplate` shells out to docker/kubectl from main; each probe needs a
  timeout so a hung daemon or a slow cluster can't stall the form.
- Template scripts grow (key volume, pull, stage lines, agent install, the
  Kubernetes wait loop). They stay plain bash the user owns; tests assert on
  their content as today (`recipe-templates.test.ts`).
- Recipes written before this ADR don't get any of the script changes. That
  is the recipe contract (they're the user's files); the docs say how to
  recreate one.
- Failure classification is regex over third-party output and will drift
  with docker/kubectl versions. It only changes the summary, never hides
  the output, so a miss degrades to today's behaviour.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
