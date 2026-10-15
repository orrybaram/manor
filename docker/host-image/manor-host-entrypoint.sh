#!/usr/bin/env bash
# Waits for the first connect to install manor-host onto the home volume
# (ADR-229 D8), then becomes its supervisor.
set -euo pipefail

shim="$HOME/.manor/bin/manor-host"
logged=0
while [ ! -x "$shim" ]; do
  if [ "$logged" = 0 ]; then
    echo "manor-host-entrypoint: waiting for $shim (Manor installs it on the first connect)" >&2
    logged=1
  fi
  sleep 2
done

exec "$shim" supervise
