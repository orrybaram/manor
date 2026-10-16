# The reference Manor host image (ADR-229 D8). No Manor *state* is baked in:
# the first connect installs `manor-host` onto the home volume, so a snapshot
# of this image holds no identity (D6). See README.md.
#
# A release build may bake in Manor *code* (ADR-235 D10): the version's host
# package, already `npm install`ed, under /opt/manor/host-<version>/. The
# first connect then copies it onto the volume instead of uploading the
# tarball and compiling node-pty. A plain `docker build docker/host-image`
# skips that and builds the image as before.
#
# python3, make and g++ are node-gyp's toolchain: node-pty has no Linux
# prebuilds, so it compiles here (baked package) or on the first connect.
# iproute2 brings `ss`, which the port list uses on Linux.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl g++ git gnupg iproute2 make openssh-client procps python3 tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The agent CLIs are yours to add. Uncomment the ones you use.
# RUN npm install -g @anthropic-ai/claude-code
# RUN npm install -g @openai/codex

# The base image's `node` user is uid 1000; `manor` takes its place.
RUN userdel -r node \
 && useradd --create-home --home-dir /home/manor --shell /bin/bash --uid 1000 manor

# The baked host package (ADR-235 D10). COPY cannot depend on a build arg, so
# prebuilt/ is always copied (it holds only a .gitignore unless the release
# job put the tarball there) and MANOR_HOST_TARBALL names the file in it to
# install. Empty: nothing is installed. VERSION, when given, must match the
# package's own version, which names the directory.
ARG MANOR_HOST_TARBALL=
ARG VERSION=
COPY prebuilt/ /tmp/manor-prebuilt/
RUN set -eu; \
    if [ -n "$MANOR_HOST_TARBALL" ]; then \
      tgz="/tmp/manor-prebuilt/$MANOR_HOST_TARBALL"; \
      [ -f "$tgz" ] || { echo "MANOR_HOST_TARBALL: $tgz is missing (put it in docker/host-image/prebuilt/)" >&2; exit 1; }; \
      v="$(tar -xzOf "$tgz" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"; \
      echo "$v" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$' || { echo "bad package version: $v" >&2; exit 1; }; \
      if [ -n "$VERSION" ] && [ "$VERSION" != "$v" ]; then echo "VERSION=$VERSION but the package is $v" >&2; exit 1; fi; \
      dir="/opt/manor/host-$v"; \
      mkdir -p "$dir"; \
      tar -xzf "$tgz" -C "$dir" --strip-components=1 --no-same-owner; \
      cd "$dir"; \
      npm install --omit=dev --no-audit --no-fund --no-package-lock; \
      for f in node_modules/node-pty/prebuilds/*/spawn-helper; do if [ -f "$f" ]; then chmod 755 "$f"; fi; done; \
      node -e 'require("node-pty")'; \
      rm -rf /root/.npm /root/.cache/node-gyp; \
      chown -R root:root /opt/manor; \
      chmod -R u+rwX,go+rX,go-w /opt/manor; \
    fi; \
    rm -rf /tmp/manor-prebuilt

COPY manor-host-entrypoint.sh /usr/local/bin/manor-host-entrypoint.sh
RUN chmod 755 /usr/local/bin/manor-host-entrypoint.sh

USER manor
ENV HOME=/home/manor
WORKDIR /home/manor

ENTRYPOINT ["tini", "--", "/usr/local/bin/manor-host-entrypoint.sh"]
