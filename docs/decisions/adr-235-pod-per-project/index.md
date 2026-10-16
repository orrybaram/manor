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

# ADR-235: A project in its own pod, in one click

> Builds on [ADR-234](../adr-234-guided-host-templates/index.md) (guided host
> templates). Its published image (D1–D2), hardened pod and sizes (D5), typed
> fields and `checkTemplate` (D6), Connect checklist (D7–D8), named stages
> and fail-fast wait (D9), failure copy (D10) and agent install (D11) are
> **not** repeated here. This ADR uses them.

## Context

The `kubernetes` recipe template (ADR-229 D8,
`electron/backend/providers/recipe-templates/kubernetes.ts`) starts one
StatefulSet of one replica, which is one host. People put every workspace of a
project there (each workspace is a worktree in that pod), and often several
projects too. That ignores what Kubernetes is good at: many small, isolated
units, each with its own limits, disk and lifetime.

**Pod per workspace stays out.** ADR-229 rejected it: the host server's
authority is per host (ADR-227), and a workspace is a worktree of its
project's checkout. **Pod per project** fits the model as it is:

- a project can be set up on any host (ADR-214);
- one recipe is one host (ADR-229 D2).

What's missing is the flow. Today it takes two separate trips through the UI:

1. Settings → Hosts → Add a host → Start a new host → the Kubernetes form.
   Wait for it to connect.
2. Add Project → Clone repository → pick the new host from the host select
   (`AddProjectDialog.tsx`). Or Set up on ▸ the host (`ProjectSetUpMenu.tsx`).

Each pod then needs its own `gh auth login` and `claude` sign-in, because
credentials never leave the laptop (`docs/remote-hosts.md` "Your credentials
stay on your laptop"). The first connect then compiles node-pty for minutes
(`remote-bootstrap.ts` `buildInstallCommands`), on every new pod.

What the code already gives us (verified):

- `hosts.createRecipe(templateId, values)` → `createRecipeFromTemplate`
  (`recipe-templates/index.ts`) writes `~/.manor/host-recipes/<id>/`.
  `hosts.addRecipeHost(recipeId)` (`bridge/handlers/hosts.ts`) saves a
  `{kind:"recipe"}` host and calls `backendRegistry.ensureConnected` without
  waiting for it.
- `backendRegistry.ensureConnected(hostId)` returns a promise that settles
  once the host is connected (or fails). `RecipeHostProvider.ensureUp`
  shares one run of `up` between callers. `projects.clone` and
  `projects.transfer` already wait on it.
- `ProjectManager.cloneProject` and `transferProject(…, "copy")`
  (`host-transfer.ts`) do the clone, adopt, health check and link.
- `hosts.remove(hostId, {destroy})` runs `destroy.sh`, then forgets the host,
  its projects and its recipe dir (`host-removal.ts`).
- `Recipe.idleStopMinutes` and `HostIdleStop` (`host-idle-stop.ts`) stop an
  idle host while the desktop is awake. No template sets it today.
- Phones paired with the desktop already reach every host's room (ADR-228
  D9). Many hosts cost the phone nothing new.
- The sidebar doesn't list hosts. Hosts show in Settings → Hosts
  (`HostsPage.tsx`, `HostRow`), the status bar (`HostStatusIndicator.tsx`),
  the phone's `HostsSheet` and pane banners.

## Decision

Five slices. Slices 1–3 deliver the one-click flow. Slices 4–5 make it feel
like one click. Slice 1 needs ADR-234's typed fields (ADR-234 ticket 4).
Slice 4 edits the Kubernetes template after ADR-234 ticket 5. Slice 5
extends ADR-234's image job (ticket 1).

### Slice 1 — Host profiles

**D1. A host profile is a template plus saved answers.**

```ts
type HostProfile = {
  id: string;                    // "hp-" + random
  name: string;                  // "Work cluster"
  templateId: string;            // "kubernetes" | "docker" (any bundled template)
  values: Record<string, string>; // every field except the per-host ones
  idleStopMinutes?: number;      // default 60; absent = off
  signIn?: { github?: SignInMeta; claude?: SignInMeta }; // D9, metadata only
};
```

- Profiles are stored in `projects.json` as `PersistedState.hostProfiles`,
  behind a small `HostProfiles` module next to `host-records.ts`. They hold
  no secrets: D9 writes tokens straight into the cluster and keeps only when
  and how they were set.
- `RecipeTemplate` gains `perHost: string[]`: the fields that differ for
  each host, which a profile never stores. Both templates have `["name"]`.
- You can have several profiles (a work cluster and a home cluster, or a
  remote Docker daemon). A profile works with **any** template. Kubernetes
  is the headline case, but the same code gives Docker "a container per
  project" for free.
- IPC (all `localOnly`, in a new `bridge/handlers/host-profiles.ts`):
  `hostProfiles.list / save / remove`. Removing a profile leaves its hosts
  alone; they just lose their heading (D7).

**D2. The profile editor reuses ADR-234's Connect step.** Settings → Hosts
gets a "Profiles" section with "New profile…". It opens `StartHostForm` in
a `mode: "profile"`:

- the same checklist (`checkTemplate`) and Advanced disclosure;
- the `perHost` fields hidden;
- a Name field, plus "Stop when idle for" (Off / 30 / 60 / 120 min, default
  60, D6);
- "Save profile" instead of Start, disabled until every check is `ok`.

Editing a profile changes only the hosts made after the edit. Recipes
already written are the user's files (ADR-229).

### Slice 2 — "In a new pod"

**D3. One operation in main: `projects.openInNewHost`.**

```ts
openInNewHost({ profileId, repoUrl, sourceProjectId? })
  → { ok: true; project: ProjectInfo; hostId: string }
  | { ok: false; stage: "up" | "clone"; hostId?: string; error: string }
```

It lives in a new `electron/projects/new-host-for-project.ts`. In order:

1. **Name.** `toDirSlug(repo name)`, cut to fit the template's
   `NAME_PATTERN` (Kubernetes names are DNS labels; the recipe id is
   `kubernetes-<ns>-<name>`, at most 64). A taken name gets `-2`, `-3`,
   and so on. Taken means a recipe dir exists, or another host of the
   profile uses the name.
2. **Recipe.** `createRecipeFromTemplate(templateId, {...values, name})`,
   with the profile's `idleStopMinutes` written into `recipe.json`.
3. **Host.** The same path as `hostsAddRecipeHost` (factored out so both use
   it). The `PersistedHost` gains `profileId` and `forProject` (D5). The
   host's display name is the repo name.
4. **Up.** Await `backendRegistry.ensureConnected(hostId)`, and also the
   host's ADR-227 adoption when one is in flight (`host-adoption.ts`). That
   way the clone takes the host-owned path, not a desktop-held record that
   is handed over later. Progress is the host's own: ADR-234 D9's stage
   lines arrive through `host.progress`.
5. **Clone.** Without `sourceProjectId`: `cloneProject({hostId, repoUrl,
   targetDir: "~/code/<slug>"})`. With it (Set up on):
   `transferProject(sourceProjectId, hostId, "copy")`, so the new checkout
   joins the source's group (ADR-214).
6. **Mark.** `forProject` is set to the new project's id.

On failure the host is **kept**, and the result says at which stage it
failed. The renderer offers Retry (re-runs from the failed stage; `up` is
idempotent, and the clone adopts an existing checkout) and "Delete the
pod" (`hosts.remove(…, {destroy: true})`). Nothing is destroyed without
asking: the recipe output is what the user needs to fix it.

**D4. The target appears wherever a host is picked for a project.**

- **Add Project → Clone repository** (`AddProjectDialog.tsx`): the host
  select gets a "New pod" group. It has one option per profile, labelled
  "In a new pod · Work cluster" ("In a new container · …" for a Docker
  profile). If there are no profiles, it shows "In a new pod…", which opens
  the D2 editor and returns to the dialog with the profile picked. "Location"
  is hidden for these options (D3 picks it). Submitting runs
  `openInNewHost`.
- **Set up on ▸** (`ProjectSetUpMenu.tsx`, `transferTargets`) and **New
  Workspace → Set up on another host…** (`HostPicker.tsx`): the same entries
  after the hosts, with `sourceProjectId`.
- **Progress.** `HostCloneSteps` / `useHostCloneFlow` gain a first step,
  "Starting <profile> pod", that shows the host's status detail. It is
  followed by the existing cloning and health steps. The health step's "Fix
  in terminal" rows are unchanged; with D9 on, they pass.

Move is gone as a concept (ADR-214), so there is no "Move to a new pod".
Set up on, then Remove from the old host, is the move.

**D5. A project's pod is kept for it, softly.** `PersistedHost.forProject`
(a project id) marks a host made by D3.

- `transferTargets` and the Add Project host list leave such a host out for
  any other project, behind a "Show all hosts" toggle. Nothing is refused:
  it is still an ordinary host.
- If that project is removed without deleting the pod (D6), `forProject` is
  cleared and the host becomes an ordinary one.

### Slice 3 — Living with many pods

**D6. Removing the project offers to delete its pod.** In
`RemoveProjectDialog` and `RemoveFromHostDialog`, when the project's host
has `forProject` equal to this project and the host can destroy:

- a checkbox, **"Also delete its pod and disk"** ("its container and
  volume" for Docker), **checked**, with "There is no undo" beneath. Checked
  runs `removeProject`, then `hosts.remove(hostId, {destroy: true})`.
- Unchecked stops the host (`hosts.stop`: scale to 0, keeping the disk) and
  clears `forProject`.
- If the destroy fails, the project is still removed. The host stays, in
  `error`, with its output, and Remove host can be retried from Settings.

Idle stop: profile hosts get `idleStopMinutes` (default 60) in their
`recipe.json`. A stopped pod keeps its disk, and opening the project wakes
it, as today. The cost note in ADR-234 D13 ("the disk keeps billing while
the host is stopped") applies to each pod.

**D7. Hosts group under their profile.**

- **Settings → Hosts** (`HostsPage.tsx`): hosts with a `profileId` render
  under a collapsible profile heading. The heading shows a count, "3 of 7
  running", and the profile's Edit / Remove. Other hosts stay where they
  are.
- **Status bar** (`HostStatusIndicator.tsx`): profile hosts roll up into one
  entry per profile, "Work cluster: 3 of 7 running". It expands to its
  hosts, and any host in `error` is still shown on its own.
- **Sidebar:** unchanged. A project's row already names its host.

### Slice 4 — Isolation and sign-in

**D8. Pods don't take connections.** Manor reaches a pod only by
`kubectl exec`, so the Kubernetes template's `up.sh` also applies, once per
namespace, a NetworkPolicy `manor-deny-ingress`:

```yaml
spec:
  podSelector: { matchLabels: { app.kubernetes.io/managed-by: manor } }
  policyTypes: [Ingress]
  ingress: []
```

The pod template gains that label and `manor.sh/host: $name`. Egress stays
open (git, npm and agents need it). Clusters without a policy controller
ignore it; the docs say so. CPU and memory isolation are ADR-234 D5's sizes.
There is no ResourceQuota, and every profile's pods share its namespace.

**D9. Sign new pods in for me (opt-in, Kubernetes profiles).** This is an
explicit change to the credential stance, for that namespace only.

- **Off by default.** Turning it on is a section of the profile editor:
  - **GitHub:** "Use this computer's GitHub sign-in" (`gh auth token` on the
    laptop) or "Paste a token" (the copy recommends a fine-grained token).
  - **Claude:** paste the output of `claude setup-token`.
- **Where tokens go.** Manor writes one Secret, `manor-signin`, in the
  profile's namespace, with keys `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`.
  It pipes them to `kubectl apply -f -` on stdin, never in argv. Manor keeps
  no copy on the laptop: the profile stores only `{ setAt, source:
  "gh" | "pasted" }` per token. Replace and Remove rewrite or delete the
  Secret.
- **How pods use them.** The pod spec has `envFrom: [{secretRef: {name:
  manor-signin, optional: true}}]`, so a pod starts the same with or without
  the Secret. The hooks step of `up.sh` runs `gh auth setup-git` as `manor`
  when `GH_TOKEN` is set. It is idempotent and lands in `~/.gitconfig` on
  the home volume, so the clone and `git push` use the token. Pods pick up a
  replaced token on their next start; the editor says "Restart running pods
  to use it", with a button that deletes each running pod of the profile
  (the StatefulSet recreates it).
- **The trade, in the copy and the docs.** Anyone who can read Secrets in
  that namespace, or exec into any of its pods, can read both tokens. Every
  agent in every pod can use them. They are the user's own tokens, not
  scoped to a pod. A namespace you share with other people is the wrong
  place for this option.
- **Docker profiles** don't get it in v1. A Docker host has no Secret store
  that isn't a file on the daemon's disk, so they keep "Fix in terminal".

Rejected:

- **A copy sealed on each host** (the Linear opt-in shape). It needs a new
  host-server method and a way to put sealed tokens into `gh` and `claude`'s
  environment, and it makes one copy per pod instead of one per namespace.
  It is no safer against someone who can exec into the pod.
- **Keeping today's stance only.** One click becomes one click plus two
  sign-ins per project, which is the thing this ADR is for.

### Slice 5 — A faster first start

**D10. The image carries a built host package.** ADR-234 D1's
`host-image` job also builds the version's host tarball
(`scripts/build-host-tarball.mjs`) and runs its `npm install --omit=dev`
inside the image build, for each arch, into
`/opt/manor/host-<version>/`. node-pty compiles there, under QEMU for arm64.
The image is already pinned to the app version (ADR-234 D2).

- `remote-bootstrap.ts`: before uploading, `ensureRemoteHost` checks for
  `/opt/manor/host-<appVersion>/` with a `require("node-pty")` probe. When
  it is there, the install step copies it (`cp -a`) into the staging dir
  instead of piping the tarball and running npm. The lock, atomic swap and
  shims stay as they are. A different version, or a failed probe, falls back
  to today's upload. Older images, other templates and SSH boxes are
  unchanged.
- **The "never snapshot" rule is kept.** It protects
  `~/.manor/remote/server/` (relay identity), which lives on the home volume
  and is never in the image. `/opt/manor` holds only code. ADR-229 D8's
  "nothing of Manor's in the image" note in `docker/host-image/README.md`
  and `docs/hosts/recipes.md` changes to "no Manor *state*".

## Resolved questions (signed off 2026-10-15)

- **Q1. Credentials.** Per-profile Secret, opt-in, Kubernetes only (D9).
- **Q2. Profiles.** Any template, several allowed (D1).
- **Q3. Removal.** The remove dialogs offer "Also delete its pod and disk",
  checked; unchecked stops it (D6).
- **Q4. Dedication.** Soft: the host is hidden from other projects' targets,
  never refused (D5).
- **Q5. Baked package.** Yes, staged in `/opt/manor/host-<version>`, falling
  back to the upload (D10).
- **Q6. Idle stop.** 60 minutes by default, editable per profile (D2, D6).
- **Q7. Isolation.** A shared namespace per profile with an ingress-deny
  NetworkPolicy; no quota, no namespace per project (D8).
- **Q8. Grouping.** On the Hosts page and in the status bar; not in the
  sidebar (D7).

**Out of this ADR:** pod per workspace (ADR-229), ResourceQuota fields,
sign-in for Docker profiles, waking a stopped pod from the phone while the
desktop is away (ADR-229, ADR-225 D8), and moving a project between pods
(Set up on + Remove covers it).

## Consequences

**Better**

- "Clone this repo into a new pod" is one choice in the dialog you already
  use. Each project gets its own CPU and memory, disk and lifetime, and
  removing the project can take its pod with it.
- The same flow gives Docker users a container per project.
- With D9 on, a new pod clones private repos and runs Claude with no
  terminal trip. With D10, its first connect skips the node-pty compile.

**Harder / risks**

- **D9 relaxes "credentials stay on your laptop"** for opted-in namespaces.
  Both tokens are readable by anyone with Secret read or exec in the
  namespace, and they are user-wide, not per pod. Mitigated by off-by-default,
  the copy, the fine-grained token suggestion and Remove. The docs'
  credentials section must say this plainly.
- **Many hosts.** Each pod is a host with its own connection (three
  `kubectl exec` children each, ADR-229 D3), its own relay room and phone
  link. Idle stop keeps most of them down, but ten running pods means about
  thirty `kubectl` processes on the laptop.
- **One disk per project** keeps billing while stopped. Idle stop saves
  compute, not storage.
- **`openInNewHost` spans two long operations** (`up` up to 15 minutes,
  then clone). A failure in the middle leaves a host with no project. D3
  keeps it, on purpose, with Retry and Delete. Anything left over shows
  under its profile on the Hosts page.
- **The image gets bigger and the release slower.** It holds node_modules
  for one version, and arm64 compiles under QEMU. The bootstrap fallback
  means a bad `/opt` only costs time.
- **Profiles don't update existing recipes**, which is the recipe contract.
  A changed image or size applies to new pods only.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
