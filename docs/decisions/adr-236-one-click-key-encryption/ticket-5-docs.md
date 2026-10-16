---
title: Docs for one-click encryption, restart-server and supervisor.env
status: done
priority: medium
assignee: haiku
blocked_by: [4]
---

# Docs for one-click encryption, restart-server and supervisor.env

Implements the documentation side of ADR-236. Read the ADR first; match the existing docs' plain, direct style.

1. **`docs/remote-hosts.md`:**
   - **"Encrypting pairing keys":**
     - Add a paragraph on the **Encrypt them** button: it makes `~/.config/manor/secret.key`, names it in `supervisor.env`, and restarts the host server. Include the honest caveat: it protects a copy of `~/.manor`, not a copy of the whole disk.
     - Recommend `manor-host secrets status --json` for checking the backend.
     - Replace the `kill "$(cat … server.pid)"` advice with `manor-host restart-server`.
     - Note the choice is sticky: a later systemd 256 doesn't move a key-file box.
     - Warn that deleting `secret.key` strands the keys, and that the recovery is Reset pairing keys.
   - **"A key from outside the box":** say the host server now reads `supervisor.env` itself (supervised or not); describe the "kept in your home" note; say an inline `MANOR_SECRET_KEY` in `supervisor.env` is now warned about.
   - **"Surviving a reboot":** turning "Keep running" off now keeps `supervisor.env`.
   - **Secrets table:** add a `~/.config/manor/secret.key` row if a "where secrets live" table exists.
   - **Troubleshooting:** add an entry for "restarted but still on plaintext" (read `~/.manor/remote/server/logs/host-server.log`).
2. **`docs/hosts/recipes.md`:** add a short section, with a stable anchor, saying a recipe host on plaintext is fixed in its recipe by giving it `MANOR_SECRET_KEY_FILE`, not by the button. If the file doesn't exist, add the section to `docs/remote-hosts.md` instead and note the anchor.
3. **`docs/decisions/adr-229-hosts-we-start/index.md`:** in Known limits, strike the "supervisor.env is read only by units" item (`~~…~~ Fixed in ADR-236.`), as earlier fixes are marked there.
4. Make sure the anchors the UI links to from ticket 4 (`SECRETS_DOCS_URL` and any recipe or container doc links in `HostRow.tsx`) exist.

## Files to touch
- `docs/remote-hosts.md`
- `docs/hosts/recipes.md`
- `docs/decisions/adr-229-hosts-we-start/index.md`
