# Manor remote-host architecture: what a project pod carries today, and which parts bind density

All sources are files in the local repository at `/Users/orrybaram/Code/manor` (commit `a9003507` on `main`, v0.22.2). Links are repo-relative paths with line anchors. Measured numbers come from the repo's own research notes and the commit that encoded them; no new measurements were taken.

## Q1. What does the pod image and first-connect bootstrap install, and which of it is per-pod when it could be per-node?

### Takeaway
Every pod runs a ~450 MB-class Debian image with Node 22, git, gh and a full C++ toolchain, then on first connect installs Manor's host package onto its own PVC (compiling node-pty unless the image has a baked copy) and `npm i -g` installs Claude Code onto the same PVC. Claude Code, the host package, the node-pty binary and the toolchain are all duplicated per pod by design even though none of them hold state.

### Cited Findings
- Image base and apt packages: `FROM node:22-bookworm-slim`; installs `ca-certificates curl g++ git gnupg iproute2 make openssh-client procps python3 tini` plus `gh` from GitHub's apt repo — [docker/host-image/Dockerfile:14-25](docker/host-image/Dockerfile#L14-L25).
- Toolchain reason: "python3, make and g++ are node-gyp's toolchain: node-pty has no Linux prebuilds, so it compiles here (baked package) or on the first connect" — [docker/host-image/Dockerfile:11-13](docker/host-image/Dockerfile#L11-L13); node-pty prebuilds exist only for `darwin-x64`/`darwin-arm64` — [electron/backend/remote-bootstrap.ts:277](electron/backend/remote-bootstrap.ts#L277).
- "No agent CLIs are baked in. Pick them under 'Agents to install' when you start a host: they go onto the home volume (~/.local)" — [docker/host-image/Dockerfile:27-28](docker/host-image/Dockerfile#L27-L28). The install loop runs `npm i -g --prefix "$HOME/.local" … @anthropic-ai/claude-code` inside the pod via `kubectl exec`, skipping when the binary is already present — [electron/backend/providers/recipe-templates/agents.ts:19-22](electron/backend/providers/recipe-templates/agents.ts#L19-L22), [agents.ts:63-66](electron/backend/providers/recipe-templates/agents.ts#L63-L66); invoked from `up.sh` — [kubernetes.ts:318](electron/backend/providers/recipe-templates/kubernetes.ts#L318). Default is `claude` only — [agents.ts:25](electron/backend/providers/recipe-templates/agents.ts#L25).
- Agent CLIs are installed onto the home volume by `up.sh`, opt-in per agent, Claude Code on by default, and not baked into the image. Rationale: the image stays agent-free (small, no stale agent versions baked in, the user's own updates stick).
- Optional baked host package: release builds may put the version's host package, already `npm install`ed, under `/opt/manor/host-<version>/`; the first connect `cp -a`s it onto the volume instead of uploading and compiling — [Dockerfile:5-9](docker/host-image/Dockerfile#L5-L9), [Dockerfile:34-60](docker/host-image/Dockerfile#L34-L60), [remote-bootstrap.ts:470-484](electron/backend/remote-bootstrap.ts#L470-L484). The release `host-image` job that would publish it has not yet run for real.
- Bootstrap requirements and path: Node >= 20 (`MIN_NODE_MAJOR = 20`) — [remote-bootstrap.ts:60](electron/backend/remote-bootstrap.ts#L60); npm install timeout 10 min — [remote-bootstrap.ts:63](electron/backend/remote-bootstrap.ts#L63); the user-facing message for the Linux compile is "building terminal support, this only happens once (about 2 minutes)" — [remote-bootstrap.ts:614](electron/backend/remote-bootstrap.ts#L614). Install is `npm install --omit=dev --no-audit --no-fund --no-package-lock` in a staging dir, then an atomic swap into `~/.manor/host/` — [remote-bootstrap.ts:503](electron/backend/remote-bootstrap.ts#L503), [remote-bootstrap.ts:441-465](electron/backend/remote-bootstrap.ts#L441-L465).
- What lands on the volume (all under `~/.manor/`): `host/` (package + node_modules), `bin/manor-host`, `bin/manor`, `hooks/notify.js`, `remote/daemon/` (socket, token, pid, log, hook journal), `remote/server/` (host server state) — [remote-bootstrap.ts:23-37](electron/backend/remote-bootstrap.ts#L23-L37), [docs/remote-hosts.md:120-135](docs/remote-hosts.md#L120-L135).
- The host tarball itself is small: five JS bundles (`terminal-host-index.js`, `pty-subprocess.js`, `agent-hook.js`, `manor-cli.js`, `host-server-index.js`) plus a generated package.json pinning runtime deps `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `tree-kill`, `ws`, `web-push` — [scripts/build-host-tarball.mjs:6-18](scripts/build-host-tarball.mjs#L6-L18), [build-host-tarball.mjs:33-42](scripts/build-host-tarball.mjs#L33-L42). The checked-in dev build is 118,510 bytes (`dist-electron/manor-host-0.20.1.tgz`, from `ls -la`).
- Image entrypoint: waits (polling every 2 s) for `~/.manor/bin/manor-host` to appear on the volume, then `exec "$shim" supervise` — [docker/host-image/manor-host-entrypoint.sh:7-16](docker/host-image/manor-host-entrypoint.sh#L7-L16). `tini` is PID 1 — [Dockerfile:75](docker/host-image/Dockerfile#L75).
- Image size estimate: the image push is ~450 MB of compressed, shared layers. The image is pinned per app version (`ghcr.io/orrybaram/manor-host:<appVersion>`).
- The first connect also registers Manor's hooks in `~/.claude/settings.json` per pod — [docs/remote-hosts.md:136-139](docs/remote-hosts.md#L136-L139), [electron/agent-connectors.ts:166-171](electron/agent-connectors.ts#L166-L171).

### Inferences
- Per-pod but stateless, so candidates for per-node sharing: the Claude Code npm install (`~/.local`), the host package and compiled node-pty (`~/.manor/host`), the g++/make/python3 toolchain, and gh. Only `~/.manor/remote/server/` (relay identity, projects/layout/agents JSON) and `~/.manor/remote/daemon/` (hook journal, sessions) are real state. The baked host package already moves code into the image; the same logic would allow a read-only shared mount.
- With the baked package verified, the toolchain (g++, make, python3) in the running image is dead weight: it exists only for the first-connect compile fallback.
- Claude Code's own per-pod cost on the PVC (npm global install) is not measured in the repo; the design accepts one copy per pod.

### Gaps
- No measurement in the repo of the uncompressed image size, the `~/.manor/host/node_modules` size, or the `~/.local` Claude Code install size.
- Whether the GHCR image is actually published with the baked package is unverified.

## Q2. What does the host server do, what state does it hold, is it per-project by design, and could one serve many pods?

### Takeaway
The host server is a full headless Manor server (projects, layout, agents, git watchers, chat mirror, GitHub, relay room) that is the authority for one *host*, not one project; it already serves many projects on one host, but it is bound to its daemon's local Unix socket and to local filesystem paths, so one server cannot span pods. Its idle footprint is ~80 MB RSS plus an always-on WebSocket to the relay and several per-workspace pollers.

### Cited Findings
- Three Manor processes per pod: `supervise` (entrypoint), the daemon (`manor-host --namespace remote`) and the host server (`manor-host serve`), all children of the shim — [docs/remote-hosts.md:193-206](docs/remote-hosts.md#L193-L206), [docs/remote-hosts.md:354-363](docs/remote-hosts.md#L354-L363). Separate processes "on purpose. A daemon restart ends every terminal" — [docs/remote-hosts.md:204-206](docs/remote-hosts.md#L204-L206).
- What `createManorServer` builds on both platforms: daemon client, `ProjectManager`, `LayoutPersistence`, worktree watchers, `RoutedBackend`, server launches, `LayoutStore`, theme, ports (`PortScanner`), GitHub, Linear, relay stores, preferences, agents, stats, notifications, `workspaceOps`, the agent pipeline, resyncs, `ChatMirror`, stream fan-out, `BridgeServer` — [electron/server/create-manor-server.ts:1-17](electron/server/create-manor-server.ts#L1-L17); imports show `BranchWatcher`, `DiffWatcher`, `WorktreeWatcher`, `PortScanner`, `PushManager`, `RelayIdentityStore`, `LinearManager`, `GitHubManager`, `KeybindingsManager`, `ThemeManager` — [create-manor-server.ts:35-99](electron/server/create-manor-server.ts#L35-L99).
- Host-only additions: ownership state, winsize hold, daemon retry loop, hook feed, "its always-on relay room" — [electron/host-server/server.ts:1-5](electron/host-server/server.ts#L1-L5). It reaches the daemon "as a plain local client over `~/.manor/remote/daemon/terminal-host.sock`" — [server.ts:7-9](electron/host-server/server.ts#L7-L9).
- Relay: "Always on. There is no enable switch … It dials on `start()` and keeps dialling," reconnects with capped backoff, failed state retried every 5 min — [electron/host-server/relay.ts:19-27](electron/host-server/relay.ts#L19-L27), [relay.ts:64](electron/host-server/relay.ts#L64). Uses the `ws` package — [relay.ts:36](electron/host-server/relay.ts#L36).
- State owned per host: `projects.json` (every record `hostId: "local"`), workspaces via git, `layout.json`, `agents.json`, `hook-cursor.json`, sealed stores (pairings, push, relay identity, Linear token); files listed in [docs/remote-hosts.md:128](docs/remote-hosts.md#L128) and [docs/remote-hosts.md:469-480](docs/remote-hosts.md#L469-L480).
- Per-host, not per-project: the host server is the authority for its host. Before pod-per-project, people put every workspace of a project on one host, and often several projects too. Pod-per-workspace was rejected because the host server's authority is per host, and a workspace is a worktree of its project's checkout.
- Background work the host server runs: agent-status driver ticks every 10 s — [electron/agent-status/driver.ts:35](electron/agent-status/driver.ts#L35); winsize poll every 2 s — [electron/host-server/winsize.ts:49](electron/host-server/winsize.ts#L49); branch watcher polls every 2 s per watched workspace — [electron/branch-watcher.ts:12](electron/branch-watcher.ts#L12); port rescan floor 3 s — [electron/ports.ts:12](electron/ports.ts#L12); branches and diffs are watched on the server that owns the workspace, with per-connection watched sets; idle debounce 60 s and hook timeout 30 s — [electron/host-server/busy.ts:22-24](electron/host-server/busy.ts#L22-L24).
- Measured idle: "the Manor host server inside each pod adds about 80 MB at near-zero CPU" — [reports/Budget VPS hosts for k3s.md:7](reports/Budget%20VPS%20hosts%20for%20k3s.md#L7), [research_notes/Budget VPS hosts for k3s/measured_usage.md:3](research_notes/Budget%20VPS%20hosts%20for%20k3s/measured_usage.md#L3). This figure covers the host server only, not the daemon, `supervise`, or PTY subprocesses.
- Laptop-side cost per pod: exec transport has no ControlMaster, so there are three `kubectl exec` children per host, plus one per window; ten running pods means about thirty `kubectl` processes on the laptop.

### Inferences
- Because the server already treats "its host" as a container of many projects, collapsing N project pods into one host (one server, one daemon) is supported by the existing model and simply reverses the pod-per-project product choice; it is not a code-architecture change.
- A single server serving many *pods* would need a daemon transport other than the local Unix socket and a non-local filesystem view, neither of which exists (`HostTransport` is Duplex-stream based, so an exec-stream daemon transport is conceivable, but the server also runs `git`, `gh` and setup scripts in the checkout directly).
- The ~80 MB server, plus a daemon and `supervise` of unmeasured size, plus the 2 s/10 s pollers, is a fixed per-pod tax that scales with pods not agents.

### Gaps
- No measured RSS for the daemon (`terminal-host-index.js`) or `supervise` process in the repo.
- No measurement of relay WebSocket keepalive bandwidth per idle host.

## Q3. How are agents launched (PTY, CLI flags, resume, transcripts), and what prevents suspending them between turns or running headless?

### Takeaway
Every agent is an interactive `claude --dangerously-skip-permissions` TUI inside a PTY, where each PTY is its own forked Node subprocess that polls the foreground process with `pgrep` every 500 ms, and every one of 12 registered Claude hook events (including every Pre/PostToolUse) spawns a `sh` then a `node` process. Nothing in Manor suspends or resumes agents on its own; status is inferred from hooks and transcripts, and resume is a human-triggered `--resume <id>` typed into a fresh PTY.

### Cited Findings
- Default command: `readonly defaultCommand = "claude --dangerously-skip-permissions"` — [electron/agent-connectors.ts:146](electron/agent-connectors.ts#L146). Resume appends `--resume <sessionId>` unless already present — [agent-connectors.ts:148-154](electron/agent-connectors.ts#L148-L154). A prompt is appended as a shell-escaped quoted positional argument — [agent-connectors.ts:156-164](electron/agent-connectors.ts#L156-L164).
- Hooks registered in `~/.claude/settings.json`: `SessionStart`, `UserPromptSubmit`, `Stop`, `PostToolUse(*)`, `PostToolUseFailure(*)`, `PermissionRequest(*)`, `PreToolUse(*)`, `Notification(permission_prompt)`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd` — [agent-connectors.ts:127-140](electron/agent-connectors.ts#L127-L140). On a remote host the hook is `notify.sh`, which does `exec node "$(dirname "$0")/notify.js" "$@"` — [electron/terminal-host/bootstrap-host.ts:35-36](electron/terminal-host/bootstrap-host.ts#L35-L36); `notify.js` reads stdin and fires a GET to the daemon's loopback hook listener — [electron/scripts/agent-hook.js:1-12](electron/scripts/agent-hook.js#L1-L12). The daemon appends to `~/.manor/remote/daemon/hook-journal.ndjson` (capped 5,000 entries / 7 days) — [docs/remote-hosts.md:694-700](docs/remote-hosts.md#L694-L700).
- One Node process per PTY: "Each PTY runs in its own child process for isolation" — [electron/terminal-host/pty-subprocess.ts:3-7](electron/terminal-host/pty-subprocess.ts#L3-L7); the daemon `fork(pty-subprocess.js)` with `ELECTRON_RUN_AS_NODE=1` — [electron/terminal-host/session.ts:266-271](electron/terminal-host/session.ts#L266-L271). The subprocess polls the foreground process every 500 ms and runs `pgrep -P` to detect agent CLIs — [pty-subprocess.ts:318](electron/terminal-host/pty-subprocess.ts#L318), [pty-subprocess.ts:359](electron/terminal-host/pty-subprocess.ts#L359), [pty-subprocess.ts:41-60](electron/terminal-host/pty-subprocess.ts#L41-L60).
- Launch happens on the server, into a PTY, with no renderer: `spawnPane` "create the session or attach to it, and type the pane's pending command into a fresh one" — [electron/server/spawn-pane.ts:1-22](electron/server/spawn-pane.ts#L1-L22). Prewarmed sessions exist on the desktop only: "a host server has none" — [spawn-pane.ts:52-53](electron/server/spawn-pane.ts#L52-L53), [docs/remote-hosts.md:888](docs/remote-hosts.md#L888).
- Scrollback is persisted per session under `~/.manor/sessions/{sessionId}/`, capped at 5 MB and truncated to 2.5 MB — [electron/terminal-host/scrollback.ts:4-18](electron/terminal-host/scrollback.ts#L4-L18).
- Busy definition: host is busy when any agent is `thinking`, `working` or `requires_input`; `requires_input` counts because an overnight prompt must still be there in the morning; going idle is debounced 60 s.
- No automatic resume: "Resuming agents by themselves after a reboot. Their panes come back when opened, with the agent's resume command" is listed under "What isn't supported" — [docs/remote-hosts.md:872-873](docs/remote-hosts.md#L872-L873); it was rejected because an agent that restarts with nobody watching could repeat side effects. After a daemon restart the pane gets "a fresh shell in the same directory, and for a pane that had an agent, that agent's resume command (for example `claude --resume <id>`)" — [docs/remote-hosts.md:711-716](docs/remote-hosts.md#L711-L716).
- The chat view reads Claude's own transcript files on the box via `ChatMirror` with `LocalTranscriptSource` ("transcripts are files on this box") — [electron/chat-mirror/transcript-source.ts:1-5](electron/chat-mirror/transcript-source.ts#L1-L5).
- Remote MCP is not provided to agents in pods; hooks and the `manor` CLI are — [docs/remote-hosts.md:875-877](docs/remote-hosts.md#L875-L877).

### Inferences
- Nothing architectural requires the interactive TUI: the server already launches with no viewer, status already comes from hooks and transcripts rather than screen scraping, and resume is already a stored session id. A headless `claude -p`/Agent SDK runner would need a replacement for the PTY as the unit of layout (panes, scrollback, phone terminal view) but not for status tracking.
- Per-agent overhead beyond Claude's own RSS: one Node PTY subprocess (unmeasured), a 500 ms `pgrep` poll, and a `sh`+`node` spawn per hook event (two per tool call). At hundreds of agents the hook spawns become a CPU/fork-rate cost, and PTY subprocess RSS becomes a memory cost.
- `requires_input` counting as busy means a pod waiting on a human never idle-stops; a "suspend between turns" design would have to redefine busy.

### Gaps
- The exact Claude transcript path the chat mirror reads (`~/.claude/projects/...`) was not located in the TS source in this pass; only the adapter test (`electron/chat-mirror/adapters/__tests__/claude.test.ts`) was found by grep.
- No RSS measurement for a `pty-subprocess.js` process.

## Q4. What is the per-pod resource spec, what triggers scale-to-zero, and how fast is wake-up?

### Takeaway
Each project is a StatefulSet of one with a 20 Gi RWO PVC, requesting 500m CPU / 1 GiB and limited to 4 GiB memory by default (no CPU limit), stopped by the *desktop* after 60 idle minutes only while the laptop is awake and nobody is viewing, and woken by `kubectl scale` to 1 followed by a 3 s poll loop (up to 14 min), the bootstrap version check, and daemon/server start, with callers waiting at most 2 min before being told "still starting". The PVC keeps billing while stopped.

### Cited Findings
- Sizes as built: `small: 250m / 512Mi / limit 2Gi`, `medium: 500m / 1Gi / limit 4Gi` (default), `large: 1 / 2Gi / limit 8Gi`; "CPU is never limited; memory spikes to ~3.5 GiB linting a large repo, so the limit sits well above the request" — [electron/backend/providers/recipe-templates/kubernetes.ts:421-433](electron/backend/providers/recipe-templates/kubernetes.ts#L421-L433). Commit `31971482` "Size Kubernetes hosts from measured agent usage" introduced these and `MANOR_K8S_MEMORY_LIMIT` (from `git show --stat 31971482`).
- The original preset text read "Small (1 CPU, 2 GiB), Medium (2 CPU, 4 GiB, default), Large (4 CPU, 8 GiB) … `limits.memory` equal to the request"; this is superseded by the code above and the report notes the old preset "would force a 16 vCPU / 32 GiB node for 8 pods" — [reports/Budget VPS hosts for k3s.md:3](reports/Budget%20VPS%20hosts%20for%20k3s.md#L3).
- Pod spec: StatefulSet `replicas: 1`, one container `host`, `runAsNonRoot`/uid 1000/`RuntimeDefault` seccomp/drop ALL caps, env `MANOR_SECRET_KEY_FILE`, `MANOR_INSTANCE_ID`, optional `envFrom` sign-in Secret, home PVC at `/home/manor`, key Secret mounted — [kubernetes.ts:109-175](electron/backend/providers/recipe-templates/kubernetes.ts#L109-L175). PVC `ReadWriteOnce`, default `20Gi` — [kubernetes.ts:45](electron/backend/providers/recipe-templates/kubernetes.ts#L45), [kubernetes.ts:166-174](electron/backend/providers/recipe-templates/kubernetes.ts#L166-L174), [kubernetes.ts:497-503](electron/backend/providers/recipe-templates/kubernetes.ts#L497-L503). Namespace-wide `manor-deny-ingress` NetworkPolicy — [kubernetes.ts:77-90](electron/backend/providers/recipe-templates/kubernetes.ts#L77-L90). "There is no ResourceQuota, and every profile's pods share its namespace".
- `stop.sh`: `kubectl scale statefulset "$name" --replicas=0`; "The claim and the secret are kept" — [kubernetes.ts:388-390](electron/backend/providers/recipe-templates/kubernetes.ts#L388-L390). `status.sh` reports `sleeping` only at 0 replicas — [kubernetes.ts:354-357](electron/backend/providers/recipe-templates/kubernetes.ts#L354-L357).
- `up.sh`: applies namespace/policy/Secret/StatefulSet, `scale --replicas=1`, then polls pod and PVC state every 3 s with named stages, failing fast on `OOMKilled`, `ImagePullBackOff`, `FailedScheduling` etc., and giving up at 840 s (14 min) — [kubernetes.ts:177-296](electron/backend/providers/recipe-templates/kubernetes.ts#L177-L296). Then writes no-op hooks and runs `gh auth setup-git`, then the agent-install loop — [kubernetes.ts:298-318](electron/backend/providers/recipe-templates/kubernetes.ts#L298-L318). Recipe runner gives `up` 15 min — [electron/backend/providers/recipe-runner.ts:23](electron/backend/providers/recipe-runner.ts#L23); timeouts: `up` 15 min, `stop`/`status` 2 min, `destroy` 10 min.
- After `up`, the host bootstraps exactly as an SSH box does: `remoteHostEnsurer` installs the version-pinned tarball, and `remote-bridge` and `server-bridge` start the daemon and the host server. On a repeat wake the bootstrap is detect → check node → `manor-host --version` match → done — [remote-bootstrap.ts:577-599](electron/backend/remote-bootstrap.ts#L577-L599).
- Wake wait: `WAKE_WAIT_MS = 2 * 60_000` — [electron/server/host-routing.ts:160](electron/server/host-routing.ts#L160); "The call waits up to two minutes for the host to come up, then answers '<host> is still starting'" — [docs/remote-hosts.md:743-747](docs/remote-hosts.md#L743-L747).
- Idle stop is desktop-side: "a recipe host with `idleStopMinutes` is stopped once its server has said it is idle that long, while this desktop is awake. With the lid closed it is the box hook's job" — [electron/backend/host-idle-stop.ts:1-14](electron/backend/host-idle-stop.ts#L1-L14). Any viewer (desktop, device, forwarded) defers the stop by 60 s rechecks — [host-idle-stop.ts:120-125](electron/backend/host-idle-stop.ts#L120-L125). Default 60 min for profile hosts. The template's `on-idle`/`on-busy` hooks are no-ops by default — [kubernetes.ts:298-309](electron/backend/providers/recipe-templates/kubernetes.ts#L298-L309). A container "can't usually stop itself this way … call your provider's API from the hook instead" — [docs/hosts/recipes.md:682-684](docs/hosts/recipes.md#L682-L684).
- Waking from the phone with the desktop away is unsupported: "nothing on the relay can start a stopped box" — [docs/remote-hosts.md:760-763](docs/remote-hosts.md#L760-L763); a Manor cloud backend holding credentials was rejected.
- Cost: one disk per project keeps billing while stopped; idle stop saves compute, not storage. k3s local-path "does not enforce the 20 Gi size, so actual clone and `node_modules` usage, not the nominal claim, fills the disk" — [reports/Budget VPS hosts for k3s.md:22](reports/Budget%20VPS%20hosts%20for%20k3s.md#L22).
- Measured basis: idle agents 0.01–0.08 cores and 220–500 MB; active 0.26 cores / 560 MB avg, 1.4 GB peak; lint+test 0.45 cores avg, 9.67 cores and 3,527 MB peak; one eslint run ~870 MB — [measured_usage.md:6-15](research_notes/Budget%20VPS%20hosts%20for%20k3s/measured_usage.md#L6-L15).

### Inferences
- Scale-to-zero requires an awake desktop or a user-written hook that calls the cluster API from inside the pod; the shipped defaults give neither, so an unattended pod with a waiting prompt runs indefinitely.
- Cold wake is bounded by pod scheduling + image pull + PVC attach + the 3 s poll granularity + bootstrap round trips + daemon/server start; the repo records no measured wake latency.
- Memory requests sum across pods regardless of activity (1 GiB × N pods), so with pod-per-project the scheduler, not actual use, caps pods per node at roughly node RAM / 1 GiB.

### Gaps
- No measured wall-clock figure for wake-up or first connect in the repo (only the "about 2 minutes" compile message and the 14/15 min caps).
- No measured RSS for a fully idle pod (supervise + daemon + server + zero agents).

## Q5. What is the per-workspace (worktree) cost, and is anything shared?

### Takeaway
A workspace is `git worktree add` into `<worktree base>/<slug>` on the pod's PVC, followed by the project's user-authored setup script in its own PTY tab; Manor installs no dependencies itself and shares nothing between worktrees, so any `node_modules` duplication is whatever the setup script does. The Manor repo's own `node_modules` is 1.8 GB.

### Cited Findings
- Worktree path: `worktreePathFor(project, name)` = `worktreeBaseDir(project)` joined with `toDirSlug(name)`; the base is the project's `worktreePath` setting (with `~` expanded on the host) or a per-host default root asked of that host — [electron/projects/path-router.ts:140-163](electron/projects/path-router.ts#L140-L163). The local default root is `~/.manor/worktrees` — [electron/paths.ts:384-386](electron/paths.ts#L384-L386).
- Creation runs `git worktree add <path> …` through the project's host — [electron/backend/exec-git.ts:297-303](electron/backend/exec-git.ts#L297-L303); "Every git and shell call goes through the project's own host" — [electron/projects/worktrees.ts:1-6](electron/projects/worktrees.ts#L1-L6); batch creation is sequential because "concurrent `git worktree add` on one repo races the index" — [worktrees.ts:46-50](electron/projects/worktrees.ts#L46-L50).
- Setup script: it runs on the server, in a tab of its own — [electron/workspace-ops.ts:9](electron/workspace-ops.ts#L9); `workspaceOps.create` runs it in a new tab whose pending command is `script; exit`. Setup scripts are stored per project in `projects.json` — [docs/ARCHITECTURE.md:233](docs/ARCHITECTURE.md#L233).
- Pods clone to `~/code/<slug>` — [docs/hosts/recipes.md:87](docs/hosts/recipes.md#L87).
- The repo's own footprint: `du -sh node_modules` = 1.8G; `git worktree list` shows 1 entry (main only); `.claude/worktrees` is empty (0 entries, 0B) though eslint ignores it as the agent-worktree location — [eslint.config.js:9-19](eslint.config.js#L9-L19). pnpm store on this Mac is `/Users/orrybaram/Library/pnpm/store/v11` (`pnpm store path`), with no `.npmrc` in the repo.
- Manor's own workspace docs say nothing about dependency installation or store sharing; grep for `node_modules` in `docs/*.md` matches only the host package's own `node_modules` — [docs/remote-hosts.md:124](docs/remote-hosts.md#L124).

### Inferences
- With a pnpm-based project and a setup script that runs `pnpm install`, each worktree gets a hard-linked `node_modules` from the pod-local pnpm store (pnpm's default), so within one pod the duplication is mostly links; across pods there is no shared store because each pod has its own PVC.
- The 1.8 GB figure is a ceiling for one worktree's `node_modules` of a Manor-sized repo without a shared store; with pnpm hard links the marginal worktree cost is much smaller but unmeasured.
- Per-workspace runtime cost is a PTY subprocess plus a branch-watcher poll every 2 s while watched (Q2).

### Gaps
- Not determined: the per-host `defaultRoot` used for remote worktrees (asked of the host at runtime; not resolved statically).
- No measurement of a worktree's disk footprint on a pod, or of `pnpm install` time inside a pod.

## Q6. What does the verification gate look like (scripts, tools, versions)?

### Takeaway
On `main` the gate is `pnpm typecheck` (two `tsc -p` runs), `pnpm lint` (eslint 10 with non-type-aware typescript-eslint), `pnpm test` (vitest 4 + knip), and `pnpm build` (typecheck then vite build); a single eslint pass over the repo measured ~870 MB RSS and lint+test peaks at 3.5 GB, which is what sets the 4 GiB pod limit.

### Cited Findings
- Scripts: `"typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.electron.json"`, `"build": "pnpm typecheck && vite build"`, `"test": "vitest run && pnpm knip:ci"`, `"lint": "eslint ."`, `"package": "… && node scripts/build-host-tarball.mjs && electron-builder"` — [package.json:8-32](package.json#L8-L32) (lines 8, 10, 15, 29, 14 respectively). A third `tsconfig.node.json` exists but is not referenced by the typecheck script (from `ls tsconfig*.json`; grep for `tsconfig.node` in package.json and vite.config.ts found nothing).
- Versions (devDependencies): `typescript ~5.8.3`, `eslint ^10.0.3`, `vitest ^4.1.0`, `knip ^6.32.2`, `prettier ^3.8.1`, `electron ^35.0.0`, `vite ^7.0.4`, `@playwright/test ^1.59.1`, `electron-builder ^26.0.0`; `packageManager: pnpm@10.23.0` — [package.json:4](package.json#L4) and devDependencies (via `node -e` over package.json). No `oxlint`.
- eslint config uses `tseslint.configs.recommended` (not `recommendedTypeChecked`) with react-hooks and react-refresh plugins — [eslint.config.js:21-32](eslint.config.js#L21-L32).
- Measured: "A single eslint run over the manor repo used ~870 MB RSS by itself"; lint + tests peak 3,527 MB and 9.67 cores — [measured_usage.md:11](research_notes/Budget%20VPS%20hosts%20for%20k3s/measured_usage.md#L11), [measured_usage.md:21](research_notes/Budget%20VPS%20hosts%20for%20k3s/measured_usage.md#L21). "a 2 GiB limit would OOM-kill a lint run on a Manor-sized repo" — [reports/Budget VPS hosts for k3s.md:9](reports/Budget%20VPS%20hosts%20for%20k3s.md#L9).
- `postinstall` runs `electron-rebuild` — [package.json:33](package.json#L33), which is desktop-only and irrelevant inside a pod.

### Inferences
- The gate is CPU-bursty and memory-spiky because tsc (×2), eslint and vitest each load the whole program; running them per pod is what forces the 4 GiB limit. Moving the gate to a shared runner (one per node, or CI) would let the pod limit drop toward the agent's own ~0.5–1.4 GB.
- The user's memory note about "tsc ×3" applies to a different branch; `main` runs two.

### Gaps
- No measurement of vitest or tsc RSS individually in the repo.

## Q7. Which of these are hard architectural commitments (accepted design decisions) versus incidental?

### Takeaway
The hard commitments a density redesign would overturn are: a host server that is the authority for exactly one host, one recipe = one host and one host per project with no per-workspace hosts, a separate daemon and server per host, no Manor state in images and one identity per instance, no Manor cloud backend holding credentials, no automatic agent resume, and agent CLIs installed per pod rather than baked. The resource numbers, PVC size, idle timeout, interactive TUI, per-PTY subprocess, and hook fan-out are incidental and already drifting.

### Cited Findings
Hard (accepted design decisions):
- "The host server is the authority for its host" and owns its `projects.json`, `layout.json`, `agents.json`. The flip is one-way per host.
- A recipe and a host are one-to-one; recipes per workspace were rejected because there is one box per project and the host server's authority is per host. "One box per project. A project's workspaces all live on its host" — [docs/remote-hosts.md:881-882](docs/remote-hosts.md#L881-L882).
- Pod per project is accepted and pod per workspace stays out.
- Daemon and host server are separate processes.
- "Never snapshot a host that has run Manor"; one identity per instance; secrets from environment not volume — [docs/hosts/recipes.md:697-720](docs/hosts/recipes.md#L697-L720).
- A Manor cloud backend that holds integration tokens for every host was rejected: Manor has no accounts and no backend that holds user data. Waking from the phone with the desktop away is out of scope for the same reason.
- Agents are never resumed automatically.
- Agent CLIs on the home volume, not in the image. Image pinned per app version.
- Exec transport without sshd, one process per stream.
- Credentials stay on the laptop, with the per-profile Secret as the single opt-in exception — [docs/remote-hosts.md:151-159](docs/remote-hosts.md#L151-L159).

Incidental (code constants or "as built" notes, not design decisions):
- `SIZES` presets and `DEFAULT_SIZE` — [kubernetes.ts:428-433](electron/backend/providers/recipe-templates/kubernetes.ts#L428-L433) (changed once already by commit `31971482`, diverging from the original preset text).
- PVC default `20Gi` — [kubernetes.ts:45](electron/backend/providers/recipe-templates/kubernetes.ts#L45); `idleStopMinutes` default 60 (editable per profile).
- The node-pty compile and toolchain requirement, framed as a v1 limitation: "v1 requires Node >= 20 on the remote and ships a version-pinned npm tarball" — [remote-bootstrap.ts:10-14](electron/backend/remote-bootstrap.ts#L10-L14).
- One forked Node process per PTY — [pty-subprocess.ts:5-7](electron/terminal-host/pty-subprocess.ts#L5-L7); 500 ms foreground poll — [pty-subprocess.ts:318](electron/terminal-host/pty-subprocess.ts#L318); 12 hook events each spawning `sh`+`node` — [agent-connectors.ts:127-140](electron/agent-connectors.ts#L127-L140), [bootstrap-host.ts:35-36](electron/terminal-host/bootstrap-host.ts#L35-L36).
- `claude --dangerously-skip-permissions` default — [agent-connectors.ts:146](electron/agent-connectors.ts#L146).
- No ResourceQuota, shared namespace per profile (a decided scope exclusion, but trivially additive).
- "How many" (one form → N hosts) and k3s-over-SSH were explicitly deferred.

### Inferences
- The binding constraints for "hundreds of agents on a tiny box", in order: (1) one 1 GiB-request pod per project with a fixed ~80 MB server + daemon + supervise tax and an always-on relay socket, which caps pods at node RAM / request regardless of load; (2) the lint/test gate running inside the pod, which forces a 4 GiB limit per pod; (3) interactive TUI agents in PTYs that are never suspended and count `requires_input` as busy, so idle agents hold 220–500 MB each indefinitely; (4) per-pod copies of Claude Code, the host package and the toolchain on per-project PVCs that bill while stopped; (5) idle stop that depends on an awake laptop.
- A redesign that keeps the host-is-the-authority model but drops pod-per-project (many projects per host, one server) removes the per-pod tax and the scheduler-request cap without touching any accepted decision except pod-per-project.
- A redesign that suspends agents between turns or runs them headless touches no accepted decision directly, but collides with "agents are not resumed by themselves" if resumption becomes automatic.

### Gaps
- The per-PTY subprocess design and the hook fan-out were never recorded as decisions; older design history was not reviewed.
