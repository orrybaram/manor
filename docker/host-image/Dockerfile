# The reference Manor host image (ADR-229 D8). Nothing Manor-specific is
# baked in: the first connect installs `manor-host` onto the home volume, so
# a snapshot of this image holds no identity (D6). See README.md.
#
# python3, make and g++ are node-gyp's toolchain: node-pty has no Linux
# prebuilds, so the first connect compiles it. iproute2 brings `ss`, which
# the port list uses on Linux.
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

# No agent CLIs are baked in. Pick them under "Agents to install" when you
# start a host: they go onto the home volume (~/.local) the first time it starts.

# The base image's `node` user is uid 1000; `manor` takes its place.
RUN userdel -r node \
 && useradd --create-home --home-dir /home/manor --shell /bin/bash --uid 1000 manor

COPY manor-host-entrypoint.sh /usr/local/bin/manor-host-entrypoint.sh
RUN chmod 755 /usr/local/bin/manor-host-entrypoint.sh

# Terminal panes are login shells, and /etc/profile resets PATH. A Kubernetes
# volume starts empty (no skel ~/.profile), so put ~/.local/bin back here.
RUN printf '%s\n' 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac' \
      > /etc/profile.d/manor-local-bin.sh

USER manor
ENV HOME=/home/manor
ENV PATH=/home/manor/.local/bin:$PATH
WORKDIR /home/manor

ENTRYPOINT ["tini", "--", "/usr/local/bin/manor-host-entrypoint.sh"]
