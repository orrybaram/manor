#!/bin/sh
# Install the run's throwaway client key, fresh host keys, then run sshd in
# the foreground. The key comes in through $AUTHORIZED_KEY so nothing has to
# be bind-mounted from the host (see scripts/test-remote-e2e.mjs).
set -eu

if [ -z "${AUTHORIZED_KEY:-}" ]; then
  echo "manor-e2e: AUTHORIZED_KEY is not set" >&2
  exit 1
fi
printf '%s\n' "$AUTHORIZED_KEY" > /home/manor/.ssh/authorized_keys
chown manor:manor /home/manor/.ssh/authorized_keys
chmod 600 /home/manor/.ssh/authorized_keys

ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
