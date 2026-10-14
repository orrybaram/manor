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

# The agent CLIs are yours to add. Uncomment the ones you use.
# RUN npm install -g @anthropic-ai/claude-code
# RUN npm install -g @openai/codex

# The base image's `node` user is uid 1000; `manor` takes its place.
RUN userdel -r node \
 && useradd --create-home --home-dir /home/manor --shell /bin/bash --uid 1000 manor

COPY manor-host-entrypoint.sh /usr/local/bin/manor-host-entrypoint.sh
RUN chmod 755 /usr/local/bin/manor-host-entrypoint.sh

USER manor
ENV HOME=/home/manor
WORKDIR /home/manor

ENTRYPOINT ["tini", "--", "/usr/local/bin/manor-host-entrypoint.sh"]
