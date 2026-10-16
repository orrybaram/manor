# Manor host image

The reference image behind the `docker` and `kubernetes` host templates
(ADR-229 D8): Node 22, git, gh, openssh-client, tini, procps and iproute2
(`ss`, for the port list), python3, make and g++ (node-pty has no Linux
prebuilds, so the first connect compiles it), a `manor` user (uid 1000, home
`/home/manor`) and `manor-host-entrypoint.sh`.

## Published image (the default)

Every Manor release publishes a multi-arch (`linux/amd64`, `linux/arm64`)
image to GitHub Container Registry, and the templates use it by default:

```sh
docker pull ghcr.io/orrybaram/manor-host:<version>   # or :latest
```

Tags match the app version. You do not need to build anything.

## Build it yourself (to customise)

Build locally only if you want to change the image, for example to bake in
extra tools:

```sh
docker build -t manor-host:local docker/host-image

# For a cluster or a remote daemon, push it where it can pull from:
docker tag manor-host:local ghcr.io/<you>/manor-host:latest
docker push ghcr.io/<you>/manor-host:latest
```

Then set the template's image to `manor-host:local` (or your pushed name).

## Nothing Manor-specific is baked in

The entrypoint waits for `~/.manor/bin/manor-host`, which Manor installs on
the first connect, and then runs `manor-host supervise`. Later versions
arrive through the normal upgrade, onto the volume. So the image holds no
host identity: a snapshot of it, or a clone of the image, cannot make two
hosts share a relay room (ADR-229 D6). The agent CLIs (Claude Code, Codex)
are yours to add: see the commented `RUN` lines in the Dockerfile.

## `/home/manor` must be persistent

Everything the host keeps lives under `$HOME/.manor`: its projects, agents,
the installed server, and its sealed identity. Mount a named volume (Docker)
or a persistent volume claim (Kubernetes) on `/home/manor`. The key that
seals the host's secrets must come from outside it: `MANOR_SECRET_KEY_FILE`
should name a file the templates mount from a separate Docker volume or a
Kubernetes Secret, never one under `/home/manor`.
