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

# ADR-231: Host server validation

ADR-230 fixed the host server's routing and lifecycle gaps. Its Scope left
two items to "a separate validation ADR", and its known limits left a few
more open. This is that ADR:
- the Kubernetes template, run against a real cluster;
- a full "lid closed" E2E;
- the root cause of the flaky "laptop closed" test;
- the E2E gaps ADR-230 covered with unit tests only.

It adds no features. It adds test suites, and it fixes what they find.

## Context

Everything below was checked against the code at `8a88f6cf` (ADR-230
merged). Paths are as of that commit.

### C1. The Kubernetes template has never run

- ADR-229 D8 shipped two recipe templates. The Docker one has a real E2E:
  `electron/backend/__tests__/recipe-docker.e2e.test.ts`, run by
  `node scripts/test-remote-e2e.mjs --recipe`.
- The Kubernetes one
  (`electron/backend/providers/recipe-templates/kubernetes.ts`) was only
  checked for shell syntax (`recipe-templates.test.ts`).
  `docs/hosts/recipes.md#kubernetes` says so.
- **What this machine has.** Docker 29 (cgroup v2, 16 CPUs, 8 GB), in
  shells that need `sg docker -c …`. There is no `kubectl`, `kind`, `k3d`,
  `minikube` or `helm`.
- **A bug, found by reading the code and still to be confirmed on a
  cluster.**
  - The template's `status` reports `sleeping` when the StatefulSet has
    replicas but its pod isn't Ready.
  - On `sleeping`, `RemoteHostConnection.beforeReconnect` stops the
    reconnect loop (`electron/backend/host-connection.ts:642`; ADR-229 D1).
  - So when a pod is deleted, evicted or rescheduled while the desktop is
    connected, the desktop would mark the host Asleep and stop reconnecting,
    though the pod comes back by itself seconds later.
  - Docker has no such state: a container that is restarting is still
    `running` to the Docker template's `status`.
- **Other parts only a cluster can exercise:**
  - `kubectl exec -i` as the exec way in, with binary stdio and stdin EOF.
    Bootstrap pipes the tarball over it, and port-pipe relies on half-close
    (ADR-230 D4).
  - The PVC's ownership under `fsGroup`.
  - The key mounted from the Secret with `subPath` and mode `0440`.
  - `rollout status` while waking from 0 replicas.
  - `destroy` naming the claim `home-<name>-0`.

### C2. "Lid closed" is tested only by cutting ssh

- `host-server.spec.ts` and `host-ownership.spec.ts` simulate a closed lid
  with `setAppTargetReachable(false)` plus `killAppSsh()`. The app process
  keeps running, keeps its timers and keeps its relay connection. "Lid
  open" is `retryHost`, the Retry button, in that same process.
- `phone-all-pairings.spec.ts` and `phone-linked-hosts.spec.ts` stop the
  desktop with `killApp`. It never comes back.
- No spec does what a laptop does:
  1. the whole desktop freezes mid-run;
  2. its network goes away;
  3. the agent on the box keeps working while a phone watches and answers
     it;
  4. the desktop thaws and recovers **with no Retry**: timers that fire
     late, sockets that are dead, a relay connection that went silent
     rather than closing.

### C3. The "laptop closed" flake: the root cause

- **The failure.** `remote-host.spec.ts` "laptop closed: hooks fired while
  away replay with one notification" sometimes never reads "thinking". It
  failed 1 of 6 runs on the ADR-230 branch, and 2 of 4 in `--docker` mode.
  ADR-230 recorded it as not traced.
- **The cause.** It was traced and reproduced while this ADR was being
  researched. Nothing ADR-230 changed is involved: `b128a6fa..8a88f6cf`
  doesn't touch this path. The chain:
  1. The stub agent (`tests/e2e/remote-host/manor-e2e-agent`) is a
     `#!/bin/sh` script. It fires `SessionStart` and `UserPromptSubmit`
     through `notify.sh`. Each hook waits about 55 ms for its HTTP reply.
     Only then does the script `exec awk`.
  2. For about 110 ms the pane's foreground process-group leader is that
     shell. On Linux, node-pty's `pty.process` names it by argv[0], which
     is `/bin/sh`.
  3. `pollForegroundProcess` (`electron/terminal-host/pty-subprocess.ts:258-294`)
     samples the foreground every 500 ms. Its shell check
     (`KNOWN_SHELLS.has(basename)`, `:279`) doesn't take the basename, so
     it reports `{name: "/bin/sh"}`.
  4. The reconciler's `agentProcessGone` (`electron/agent-status/reconciler.ts:807-812`)
     does take the basename, finds `sh`, and decides the agent is gone.
     Rule F1 then idles the pane and persists `responded`.
  5. The `awk` facts that follow don't bring the agent back: F1 only acts
     on a live status, and F3 tracks no agent.
- **When it happens.** A sample lands in that window after
  `UserPromptSubmit` about one run in five, and more often in a slower
  container. Then "thinking" lasts milliseconds, and the 250 ms poll
  misses it. In Docker, the same mechanism explains the other symptom, the
  desktop already reading "responded" right after the ssh kill.
- **The evidence.**
  - With a `sleep 1` inserted after the last hook, the host-server log
    shows `hook UserPromptSubmit → thinking` and, 257 ms later,
    `paneFacts → idle (agent process exited)`.
  - With a re-check 1.5 s later, the test fails 2 of 2:
    `Expected "thinking", Received "responded"`.
  - Natural runs passed 8 of 8 on the private sshd. The race window is
    narrow.
- **This is a product bug, not only a test bug.** A real agent fires its
  hooks from inside its own process, so for the stub's exact sequence only
  the test is wrong. But the same misreading hits any agent started through
  a wrapper that doesn't `exec`, for example `#!/bin/sh … claude "$@"`.
  - The wrapper's shell leads the foreground group for the agent's whole
    life.
  - Each time the pane's facts change (a title update, for instance), the
    pane reads "agent gone".
  - Neither the basename slip nor the reconciler can tell the pane's own
    interactive shell from a shell that is running a script.

### C4. ADR-230's E2E gaps

ADR-230 listed these as "covered by unit tests only". A survey of the
harnesses while writing this ADR found that each can be reached:
- **D3, restore doesn't wake.** A spec can write a custom recipe into
  `${tempHome}/.manor/host-recipes/<id>/` and register it with
  `hosts.addRecipeHost(id)` (`electron/bridge/handlers/hosts.ts:82-107`).
  - Its `up.sh` can return an ssh way in to the harness's own sshd, read
    from the `manor-e2e-direct` block of `MANOR_E2E_SSH_CONFIG`. The
    recipe provider gives it its own `known_hosts` file and a
    `HostKeyAlias` (`recipe-provider.ts:444-470`).
  - A recipe with no `status` script stays asleep across restarts, because
    `host.json` keeps `last: "sleeping"` (`recipe-provider.ts:209,
    315-318, 330-340`).
  - Relaunching against the same `tempHome` has a precedent
    (`viewport.spec.ts:24-75`, `agent-rename.spec.ts:230-283`).
  - The blocker: `openRemoteProject` hard-codes the ssh host
    (`tests/e2e/helpers/remote-project.ts:47-88`).
- **D1, idle stop counts phones.** It needs the D3 recipe host plus a
  phone paired with the host (`pairHostPhone`, `withLocalRelay`,
  `pointHostServerAtRelay`, already used by `host-server.spec.ts`).
  - The real app runs `HostServerSync`, so the real idle-stop path runs.
  - The cost is time. `idleStopMinutes` is a whole number of minutes, at
    least 1 (`recipes.ts:156-161`), and the recheck is a fixed
    `IDLE_STOP_RECHECK_MS = 60_000` (`host-idle-stop.ts:20`). With no
    override, one run takes about 3 minutes.
- **D5, drop grace.** `tests/e2e/helpers/latency-proxy.ts` is a TCP proxy
  for the relay.
  - `dropAll()` destroys every socket, so the phone sees a 1006 with no
    close frame. `outage()` refuses new connections.
  - `mobile-audit.spec.ts:272-274, 432, 461` already puts a phone behind
    it, but never asserts the reachability overlay (`web-app-unreachable`,
    `src/web/screens.tsx:91`).

## Decision

### D1. A kind cluster in the harness: `--k8s`

"A real cluster" here means **kind** (Kubernetes in Docker). It runs a
conformant Kubernetes on the Docker daemon this machine already has. The
same steps work on any Linux or macOS machine with Docker.
- **Why kind.**
  - k3d would work as well, but kind is the upstream SIG project and its
    node images track Kubernetes releases one to one.
  - minikube adds a VM driver layer for nothing here.
  - A cloud cluster can't be run on every change, and needs credentials
    the suite shouldn't hold.
- **Binaries.**
  - The harness uses `kind` and `kubectl` from `PATH` if they are there.
  - Otherwise it downloads pinned versions into
    `~/.cache/manor-e2e/bin/` and checks each against a SHA-256 written in
    the script. The pins are the latest kind release and its matching
    kubectl minor, as of the ticket and at least two weeks old.
  - Nothing is installed system-wide, and nothing goes under the repo.
- **The cluster.**
  - `kind create cluster --name manor-e2e --kubeconfig <tmp>/kubeconfig`,
    with the node image pinned by digest.
  - The suite gets `KUBECONFIG=<tmp>/kubeconfig`, so `~/.kube/config` is
    never read or written.
  - The image goes in with `kind load docker-image manor-host:e2e`. The
    template's default pull policy for a non-`latest` tag is
    `IfNotPresent`, so no registry is needed.
  - The cluster is deleted at the end unless `MANOR_E2E_K8S_KEEP=1`, the
    counterpart of `MANOR_E2E_RECIPE_KEEP`.
- **Usage.**
  - `node scripts/test-remote-e2e.mjs --k8s` builds the app, the tarball
    and the image, as `--recipe` does.
  - Here it runs as `sg docker -c 'node scripts/test-remote-e2e.mjs --k8s'`.
  - Without Docker it is skipped with a message, as `--recipe` is.

### D2. The recipe E2E's desktop side is shared

`recipe-docker.e2e.test.ts` builds the desktop's side inline: a
`BackendRegistry` with a real `RecipeHostProvider`, a `HostRouting`,
`launchAgent`, `agentActive`, `serverPid` and `freshServerClient`.
- These move into `electron/backend/__tests__/recipe-e2e-harness.ts`. It
  is parameterised by one function that runs a command on the box as the
  `manor` user: `docker exec` for Docker, `kubectl exec` for Kubernetes.
- The Docker suite keeps its scenarios and their numbering. Only its setup
  moves.

### D3. The Kubernetes suite

`electron/backend/__tests__/recipe-kubernetes.e2e.test.ts`, skipped unless
`MANOR_E2E_K8S=1`.
- **Setup.**
  - It writes a recipe from the bundled `kubernetes` template, as the Hosts
    page does: the namespace `manor-e2e-<suffix>`, the image
    `manor-host:e2e` and `1Gi` of storage.
  - It edits the generated `up.sh` the way the Docker suite edits its own:
    the StatefulSet gets `MANOR_RELAY_URL=http://127.0.0.1:9`, so a test
    box never dials the production relay.
- **Scenarios**, numbered like the Docker suite's where they match:
  1. `up` over `kubectl exec`.
     - The namespace and the Secret are created, and the StatefulSet rolls
       out.
     - Bootstrap pipes the tarball over `kubectl exec -i`.
     - The host server ends up under `supervise`, adoption completes, and a
       workspace and an agent run.
  2. **The pod is deleted** (`kubectl delete pod <name>-0`), the closest
     thing to a node reboot or a reschedule.
     - With the desktop connected, it must reconnect by itself. It must not
       go to `sleeping` while the pod restarts.
     - With the desktop disconnected, the host server must come back under
       `supervise` with no connect, in the same relay room, sealed by
       `key-file` from the Secret.
     - An agent launched afterwards starts.
     - **This is the scenario expected to fail first (C1).**
  3. **Stop and wake.**
     - `stop` scales to 0, and the host stays `sleeping` with no
       reconnects for 10 s.
     - A routed write (create a workspace) runs `up`, which scales to 1 and
       waits for the rollout. The write then succeeds.
  5. The `on-busy` hook that `up` wrote runs when an agent works.
  6. A port forward over `kubectl exec` (`port-pipe`) reaches a server in
     the pod.
  8. A forced drop: the box's `server-bridge` and `remote-bridge` are
     killed, and the owner channel and the host come back to the same host
     server.
  7. **Remove with destroy**, run last: the StatefulSet, the claim
     `home-<name>-0` and the Secret are gone, and the host is unlisted. The
     namespace is left to the harness.
  10. **Half-close through a port forward** (ADR-230 D4): the client that
      shut its write side still gets the reply.
- **Not in the Kubernetes suite**, each covered by the Docker suite with
  the same desktop code:
  - Clone detection (scenario 4). Copying a PVC in kind needs a helper pod.
    The `MANOR_INSTANCE_ID` check doesn't depend on the template.
  - The moved box (scenario 9). A StatefulSet's pod keeps its name, so its
    exec target doesn't move.
- **Fixing what it finds.**
  - Each template bug the suite finds is fixed in `kubernetes.ts` in the
    same ticket, with a unit test in `recipe-templates.test.ts` where a
    script's text can show it.
  - **The expected fix for C1.** `status` reports `up` (with
    `detail: "the pod is not ready yet"`) whenever replicas are 1 or more,
    and `sleeping` only for 0 replicas. The reconnect loop then keeps
    redialling while the pod restarts, and it can still tell a stopped host
    from a running one.
  - Scenario 2 must fail before that fix and pass after it. If the cluster
    shows a different cause, the ticket records that and fixes the real one.
- **The docs.** `docs/hosts/recipes.md#kubernetes` drops "haven't been run
  against a cluster" and says which cluster and version the template was
  tested on.

### D4. A full "lid closed" E2E: `tests/e2e/lid-closed.spec.ts`

One spec, added to the harness's `PLAYWRIGHT_SUITES`. It runs on the
private sshd and in `--docker`.

1. **Setup.**
   - A remote project and an agent pane, through `openRemoteProject`.
   - A phone paired with the desktop over the local relay
     (`relay-fixture`), linked to the box through `linkHostPairings`, as in
     `phone-linked-hosts.spec.ts`. The box's host server points at that
     relay (`pointHostServerAtRelay`).
   - A second pane runs a ticker on the box: one numbered line a second.
2. **The lid closes.**
   - The spec freezes the Electron process tree with `SIGSTOP`. The tree
     is the main pid from `electronApp.process()` and its descendants,
     except `ssh`.
   - Then it cuts the network: `setAppTargetReachable(false)` and
     `killAppSsh()`.
   - The relay connection of the frozen desktop goes silent rather than
     closing, as it does on a real sleep.
3. **While it is closed.** The box works:
   - The agent goes working → requires_input (`fire-hook`).
   - The phone sees each status live through the box's pairing.
   - The phone types an answer into the agent's pane. The box's input log
     shows it.
   - More hooks take the agent to responded.
   - The ticker keeps writing.
   - On the phone, the desktop's own project reads as away within 30 s,
     and the box's project stays live.
4. **The lid opens.**
   - The spec runs `setAppTargetReachable(true)` and thaws the tree with
     `SIGCONT`. It calls **no `retryHost`**.
   - Within the reconnect backoff's ceiling (30 s) plus one step, the host
     reads `connected` and the offline banner is gone.
   - The agent's final status is `responded`, with exactly one
     notification for the absence.
   - The ticker pane's text holds the lines written while the desktop was
     away, each exactly once.
   - The phone's desktop pairing is reachable again.

What the spec doesn't fake:
- `powerMonitor`'s `resume` event. `SIGSTOP` doesn't send it, so the spec
  proves recovery without it.
- Push delivery: the harness has no push service.

If step 3's "desktop reads as away" doesn't hold, because a frozen peer
never closes its socket, the ticket keeps the assertion and records the
failure. It does not weaken the assertion to make it pass. The fix then
becomes its own ticket under this ADR.

### D5. The flake: a shell running a script is not the pane's shell

The fix is in the product, because the misreading is real (C3). The test
gets a deterministic regression test.

- **The foreground sampler tells the two shells apart**
  (`electron/terminal-host/pty-subprocess.ts`).
  - Basename the name before `KNOWN_SHELLS`. This makes the two layers
    agree.
  - When the leader of the foreground process group is a shell **and is
    not the pane's own shell process**, it is a shell running something.
    The pane's own shell's pid is `ptyProcess.pid`. The foreground group
    comes from `tpgid` in `/proc/<shell pid>/stat` on Linux, and from
    `ps -o tpgid=` on macOS.
  - For such a shell, the sampler reports a non-shell name: the script's
    basename from the leader's argv (`ps -o args=`). It resolves an agent
    among the leader's descendants with the existing
    `detectAgentFromChildArgs`, so `#!/bin/sh … claude "$@"` reads as
    `claude`.
  - A lookup that fails falls back to today's answer, so a slow `ps` costs
    nothing worse than today.
- **The reconciler needs no change.** A non-shell foreground with no agent
  kind already counts as "the agent's child while a turn is in progress"
  (`agentProcessGone`). So during a turn the wrapper no longer reads as
  "gone", and once the turn is over it behaves as today.
- **Rejected:**
  - **Only fixing the stub** (firing the hooks from inside `awk`). That
    unflakes the test but leaves non-`exec` wrappers broken.
  - **A grace window in F1** (ignore "gone" within a few hundred ms of a
    hook). It hides the race rather than fixing the misreading, and it
    delays detecting a real exit.
- **Tests that fail today:**
  - `pty-subprocess`: a pane running `sh script` reports the script, not
    null and not `/bin/sh`; a pane whose wrapper runs a child agent reports
    the agent.
  - A reconciler test: SessionStart, UserPromptSubmit, then facts with a
    non-shell foreground of no kind. The status is still `thinking`, and
    nothing is persisted.
  - An E2E check: the stub gains `--linger-ms N`, which sleeps between its
    last hook and `exec awk`. `remote-host.spec.ts` "laptop closed" runs it
    with 1500 ms and re-reads "thinking" 2 s after first seeing it.
- `docs/remote-hosts.md#testing` drops the "Seen flaky" paragraph and the
  two "laptop closed" rows, once 10 runs on the private sshd and 4 in
  `--docker` pass. If `--docker` still flakes, the row stays, with what is
  left.

### D6. ADR-230's E2E gaps, closed where they can be

- **A recipe host in Playwright**, for D3 and D1:
  - A new helper, `tests/e2e/helpers/recipe-host.ts`, writes a custom
    recipe whose `up.sh` returns an ssh way in to the harness's sshd
    (`MANOR_E2E_SSH_CONFIG`'s direct block, the harness's client key).
  - The recipe has no `status`. Its `stop.sh` prints `{}`. `up.sh` appends
    a line to `up-count` in the recipe folder, so a spec can tell whether
    `up` ran.
  - `openRemoteProject` gains a variant that takes a host id and name
    instead of hard-coding `manor-e2e`.
  - A spec never registers both the ssh host and the recipe host for the
    same box.
- **D3, restore doesn't wake: `tests/e2e/host-restore-asleep.spec.ts`.**
  1. Launch, open a remote project on the recipe host, and mount a pane.
  2. Wait for `layout.json` and `viewport.json`, then stop the host
     (`hosts.stop`) and kill the app.
  3. Relaunch against the same `tempHome`.
  4. Assert:
     - the host is `sleeping`;
     - `up-count` hasn't grown;
     - the asleep banner is on the restored pane.
  5. "Wake it" runs `up` once, and the pane reattaches.
  6. A second case: after a relaunch, opening another workspace of that
     host wakes it. That is the narrowing ADR-230 D3 made.
- **D1, idle stop counts phones: `tests/e2e/host-idle-stop.spec.ts`.**
  1. The recipe has `"idleStopMinutes": 1`, and no agent runs on the box.
  2. A phone paired with the host keeps a pane of the box open, and the
     desktop leaves that workspace.
  3. For 2½ minutes the host stays `connected` and `stop` doesn't run.
  4. The phone closes, and the host goes `sleeping` within 90 s.
  5. About 4 minutes, in a spec of its own so a quick run can leave it out
     with `--grep-invert`.
- **D5, drop grace: a new test in `tests/e2e/web-app.spec.ts`.** A phone
  paired with the desktop reaches the relay through `startLatencyProxy`
  with 0 RTT.
  - `dropAll()`, then the relay is reachable again at once: for 3 s,
    `web-app-unreachable` never shows.
  - `outage()`: the overlay shows within 4–8 s, and a bridge call made
    then fails fast (under 2 s) rather than hanging.
  - `restore()`: the overlay goes.
- **Stays unit-only, and why:**
  - **D1's `forwarded` class** (a phone or window going through the
    desktop). It would double the slowest spec for one boolean. The
    `device` and `desktop` classes go end to end, and `forwarded` uses the
    same `viewing()` path.
  - **D5's "calls move to a desktop that lists the host".** One latency
    proxy fronts every room of the local relay, so a spec can't cut one
    server's pipe and keep another's. Keep `ws.test.ts` and
    `relay-pipe.test.ts`.
  - **A shorter idle stop.** No test-only override of `idleStopMinutes` or
    `IDLE_STOP_RECHECK_MS` is added. The product's own constants are what
    get tested, at the cost of about 4 minutes.

### D7. Docs and the record

- `docs/remote-hosts.md#testing` gains the `--k8s` mode, the four new
  specs, and the flake's resolution.
- `docs/hosts/recipes.md#kubernetes` gets the cluster result.
- ADR-229's known limit "The Kubernetes template was syntax-checked only"
  and ADR-230's "E2E gaps" and "Flaky tests" entries are struck through,
  with a pointer here.
- This ADR's "Known limits as built" is written from what the runs show.

### Scope

**In:** D1–D7.

**Out**, each still its own later decision:
- waking a host from the phone while the desktop is away;
- agents resuming on their own after a reboot;
- vendor providers and billing;
- the other limits ADR-230 listed (version skew, the phone's diff-pane
  reads, `pendingMints`, lookup cost, and so on);
- running the Kubernetes suite in CI: there is no CI for any of the
  remote suites today;
- a managed cluster (EKS, GKE). A kind result says the template is right
  for conformant Kubernetes. A cloud cluster's storage classes, admission
  policies (for example Pod Security `restricted`) and exec timeouts can
  still differ.

## Consequences

**Better**
- The Kubernetes template is tested, not just syntax-checked. The pod
  restart bug, if confirmed, is fixed before a user hits it.
- A real sleep is tested: frozen, cut off, thawed, recovering with no
  Retry, with the phone working the whole time.
- The "laptop closed" flake is fixed at its cause. Agents started through a
  non-`exec` wrapper script stop reading as gone on Linux.
- Restore-not-waking, idle stop with phones and drop grace are tested end
  to end. What is left unit-only says why.

**Harder**
- **The harness downloads two binaries**, pinned and checksummed. Each
  bump means new checksums.
- **The remote suites get slower.** The idle-stop spec takes about 4
  minutes, and the Kubernetes suite about 10 minutes beyond the bootstrap.
  `--grep-invert` and the separate `--k8s` mode keep quick runs quick.
- **The foreground sampler runs one more `ps` or `/proc` read** per
  change, only while a shell other than the pane's own leads the
  foreground.

**Risks**
- **kind isn't a cloud cluster.** Its local-path storage ignores `fsGroup`,
  and its node is a container. A pass says the scripts and the exec
  transport work. It doesn't promise every managed cluster accepts the
  manifest. The docs say which cluster passed.
- **Memory.** A kind node takes 0.6–1 GB of the box's 8 GB, next to the
  Electron app and a host container. One worker, as today.
- **`SIGSTOP` on Electron** freezes the Playwright connection too. The spec
  must not touch the page while it is frozen. Each step outside the frozen
  window waits on a condition, never on a fixed delay.
- **The wrapper detection** reads another process's argv. A wrapper that
  changes its own title, or a shell that isn't in `KNOWN_SHELLS`, falls
  back to today's behavior. That is no worse than today.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
