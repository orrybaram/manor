---
title: Hosts settings page, removal, and asleep hosts on the phone
status: todo
priority: high
assignee: opus
blocked_by: [1, 4, 5, 6, 7]
---

# Hosts settings page, removal, and asleep hosts on the phone

ADR-229 D7 (phone) and D8 (UI). Follow `.claude/rules/ui-components.md`: use
`Button`, `Tooltip`, `Link` and the `EmojiInput` family from
`src/components/ui/`. Read the `react` skill before writing components.

## What to build

- **Backend: removal**
  - `hosts.remove(hostId, {destroy: boolean})` (owner-only):
    1. If `destroy`, run `provider.destroy()` first. If it fails, stop
       there and report.
    2. `registry.unregister(hostId)`.
    3. Delete the `PersistedHost` and `~/.manor/host-cache/<hostId>.json`.
    4. Drop group members on that host (ADR-192 normalisation), and its
       known_hosts and ssh stanza (ticket 4).
    5. With `destroy`, also delete `~/.manor/host-recipes/<recipeId>/`.
  - `hosts.projectsOnHost(hostId)` returns the names of the projects the
    host holds (from `HostProxy`'s cache), for the confirm dialog.
- **Settings → Hosts** (`src/components/settings/HostsPage/`), a new page
  in the settings modal's nav. It lists each host (including **This Mac**,
  read-only) with:
  - **its status** from `host-store`: Connected, Connecting with the
    progress line, Asleep, Away, or Error with the message. A recipe host
    whose `status` said `missing` shows "\<name\> no longer exists" with
    **Start it again** (`hosts.wake`) and **Remove**.
  - **Wake** and **Stop**, shown only when the capabilities allow them.
  - **"Keep Manor running when \<host\> restarts"**, a switch calling
    `hosts.setSupervised`. Below it, the supervisor status:
    - "Runs at boot (systemd)";
    - "Starts after you log in to \<host\>. Run `sudo loginctl
      enable-linger <user>` to start it at boot.";
    - "Starts at login (launchd). A headless Mac needs automatic login.";
    - "Runs from the container's entrypoint".
  - For a recipe with an idle stop and no lid-closed path (ticket 6's
    `idleStopNote`): "Stops after N min idle only while This Mac is awake".
  - A link to that host's section of Remote control (`HostPhoneAccess`).
  - **Remove…** opens a dialog:
    - "Remove from Manor": a plain confirm.
    - "Destroy host and its disk": only when `canDestroy`. It lists
      `projectsOnHost`, warns that their workspace names, folders and linked
      issues live only there, and enables the button only once the host's
      name is typed.
- **Add host** has two choices:
  - **An SSH box.** Move the target field and flow out of
    `ProjectHostSection` into a shared component. Both places use it, and
    the project section links to the Hosts page.
  - **Start a host.**
    - Pick a template from `hosts.listTemplates()` or **Custom recipe**.
    - For a template, render its fields, then `hosts.createRecipe` and
      `hosts.addRecipeHost`.
    - For a custom recipe, explain the contract in two lines, link
      `docs/hosts/recipes.md`, and offer **Create recipe folder**. That
      writes a skeleton `recipe.json` and `up.sh` and reveals the folder in
      Finder. Use the existing reveal helper; find it.
    - Progress streams from the host's status while `up` runs.
- **Phone**
  - The Hosts sheet (ADR-228 D8) and sidebar host rows show **Asleep** for a
    sleeping host.
  - **Wake** calls `hosts.wake` on home. It is enabled only when home is a
    reachable desktop that lists the host.
  - Otherwise the row reads "\<host\> is asleep, and \<desktop\> is away".
  - The renderer router's wake-on-write (ticket 1) shows a toast "Waking
    \<host\>…" while it waits.
- **Status bar and `HostIndicator`.** Asleep gets its own icon and tone:
  calm, not an error.

## Tests

- Component tests where the repo has them for settings sections. Cover:
  - the remove dialog's typed confirm;
  - capability-gated buttons;
  - supervisor status texts.
- `hosts.remove` unit tests: destroy failure stops removal; groups pruned;
  cache deleted.

## Files to touch
- new `src/components/settings/HostsPage/*`, the settings nav (`src/components/settings/SettingsModal/*`)
- `src/components/settings/ProjectHostSection/ProjectHostSection.tsx` (extract add-SSH-box form)
- `src/store/host-store.ts`
- `src/components/hosts/*` (Asleep state)
- phone Hosts sheet and sidebar host row components (ADR-228 D8; find them under `src/components/phone*` or similar)
- `electron/bridge/handlers/hosts.ts`, `electron/bridge/routes.ts`, `electron/backend/registry.ts`, `electron/projects/*` (remove host)
