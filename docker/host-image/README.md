# Manor host image

The reference image behind the `docker` and `kubernetes` host templates
(ADR-229 D8): Node 22, git, gh, openssh-client, tini, procps and iproute2
(`ss`, for the port list), python3, make and g++ (node-pty has no Linux
prebuilds, so it has to be compiled), a `manor` user (uid 1000, home
`/home/manor`) and `manor-host-entrypoint.sh`. The release image also carries
the version's host package, already installed (see below).

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

A plain build like this bakes in no host package, so the first connect
uploads one and compiles node-pty. To bake one in the way the release does
(ADR-235 D10), build the tarball, put it in `prebuilt/` and name it:

```sh
pnpm build && node scripts/build-host-tarball.mjs
cp dist-electron/manor-host-<version>.tgz docker/host-image/prebuilt/
docker build -t manor-host:local \
  --build-arg MANOR_HOST_TARBALL=manor-host-<version>.tgz \
  --build-arg VERSION=<version> \
  docker/host-image
```

The build unpacks it into `/opt/manor/host-<version>/` and runs `npm install
--omit=dev` there, so node-pty compiles at build time, not on the first
connect. It checks that node-pty loads, and leaves the directory owned by
root and read-only to everyone else. Git ignores everything in `prebuilt/`
except its `.gitignore`.

## Manor code may be baked in, Manor state never is

The entrypoint waits for `~/.manor/bin/manor-host`, which Manor installs on
the first connect, and then runs `manor-host supervise`. When the image has
`/opt/manor/host-<version>/` for the connecting app's version and node-pty
loads from it, that install copies it onto the volume instead of uploading
the tarball and compiling node-pty. Any other version, or a failed check,
falls back to the upload. Later versions arrive through the normal upgrade,
onto the volume.

`/opt/manor` holds only code. Everything that makes a host *this* host,
above all its relay identity in `~/.manor/remote/server/`, is created on the
volume and never in the image. So a snapshot of the image, or a clone of it,
cannot make two hosts share a relay room (ADR-229 D6). The agent CLIs
(Claude Code, Codex) are not baked in: the Docker and Kubernetes templates
install the ones chosen under "Agents to install" onto the home volume
(`~/.local`, which the image puts on `PATH`) the first time a host starts.

## `/home/manor` must be persistent

Everything the host keeps lives under `$HOME/.manor`: its projects, agents,
the installed server, and its sealed identity. Mount a named volume (Docker)
or a persistent volume claim (Kubernetes) on `/home/manor`. The key that
seals the host's secrets must come from outside it: `MANOR_SECRET_KEY_FILE`
should name a file the templates mount from a separate Docker volume or a
Kubernetes Secret, never one under `/home/manor`.
