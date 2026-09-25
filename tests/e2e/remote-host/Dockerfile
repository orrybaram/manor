# A throwaway Linux box for the remote-host E2E suite (ADR-160 / ADR-178).
#
# Built and run by scripts/test-remote-e2e.mjs in `--docker` mode. It is what
# exercises the Linux paths a macOS sshd cannot: `uname` → Linux, node-pty
# compiled from source during the Manor host bootstrap (no darwin prebuilds
# here), and `ss` + /proc port scanning.
#
# Node lives in /usr/local/bin (from the base image), which is on the PATH a
# non-interactive ssh session gets, so bootstrap finds it without a login
# shell. python3/make/g++ are node-gyp's toolchain for node-pty.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-server git python3 make g++ iproute2 procps curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The ssh user. Its public key arrives at runtime (see entrypoint.sh), so the
# image holds no key material and one image serves every run.
RUN useradd --create-home --shell /bin/bash manor \
  && mkdir -p /run/sshd /home/manor/.ssh \
  && chown manor:manor /home/manor/.ssh \
  && chmod 700 /home/manor/.ssh

COPY sshd_config /etc/ssh/sshd_config.d/manor-e2e.conf
COPY entrypoint.sh /usr/local/bin/manor-e2e-entrypoint
RUN chmod 755 /usr/local/bin/manor-e2e-entrypoint

EXPOSE 22
CMD ["/usr/local/bin/manor-e2e-entrypoint"]
