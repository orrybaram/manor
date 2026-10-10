# Changelog

## [0.19.8] - 2026-10-09

### Fixes
- Achievements you had already earned are now awarded quietly when Manor loads, so you no longer get repeat badge notifications for them.

## [0.19.7] - 2026-10-09

### Features
- Redesigned the Trophy Room, with badge tracks, titles, secret badges and track completion
- Achievements are regrouped into four Manor tracks (Staff, Orders, Grounds, Tenure), plus a new hidden "Lord of the Manor" achievement
- Added a title picker so you can choose the title shown next to your GitHub name
- New unlock toast: it appears as a medal, pulses, then expands with a "View details" button
- Clicking a badge notification opens the Badges tab on that badge's track
- Copy or move a project to another host in one click, using the new "Copy to" / "Move to" sidebar menus
- A fallback dialog for project transfers, with local targets, prefilled fields and a copy mode
- Set up a project on another host, or remove it from one, from the sidebar
- Projects from the same origin are joined automatically, with a toast to tell you
- New Set-up dialog, a host picker in New Workspace, and host options in Project Settings

### Fixes
- New workspaces now go into their folder when they're created
- Health check shows a single Agent CLI check, which passes with any known agent
- Failed host checks now say which check failed, and `gh` and `codex` are run from their resolved paths
- Moving a project onto its own host now re-clones it
- Badges in a track are sorted by tier, then by target
- Fixed several problems in the project set-up flows

### Improvements
- The Trophy Room opens on Stats and keeps the same height when you switch tabs
- Tidier track cards and a smoother fade at the scroll edge
- A tooltip no longer appears after you pick a menu item
- The edit-title pencil only shows on hover
- The unlock toast is now anchored to the bottom, with thinner overlapping pulse rings, and stays up for 8 seconds

## [0.19.6] - 2026-10-09

### Features

- Create workspaces directly from the Tasks view without leaving it

### Improvements

- The folder picker now shimmers while Jev is choosing a folder, and the "Suggested" label is gone

### Fixes

- Each settings hint now stays inside its own setting's row

## [0.19.5] - 2026-10-09

### Features
- The New Workspace dialog now suggests a folder and selects it for you
- Folder suggestions run as a hosted service, so you no longer need your own API key
- Added a setting to turn folder suggestions on or off

### Fixes
- Clicking the title bar now closes open popovers and menus
- Fixed Git authentication prompts failing on macOS
- Fixed folder suggestions failing on large requests

### Improvements
- When cloning a repository fails, Manor now explains what went wrong and how to fix it

## [0.19.4] - 2026-10-07

### Features

- "Fix with agent" on the dashboard now starts the agent in the background and shows a toast, so you stay where you are.
- A "Needs you" card on the dashboard now goes away once you take its main action.

### Fixes

- Clicking Retry on a disconnected host now starts a reconnect attempt right away.

### Improvements

- An agent's first prompt now reaches it more reliably. The prompt is passed in a file on the pane's host instead of inside the launch command.

## [0.19.3] - 2026-10-05

### Features
- The New Workspace dialog has a new optional agent prompt field
- Hovering the stats icon in the status bar now shows a popover with quick stats

### Fixes
- Count badges on accent backgrounds now use dark text, so they're easier to read
- PR merge-queue status now comes from the latest PR poll instead of stale cached data

## [0.19.2] - 2026-10-05

### Features
- The pull request popover now shows assigned reviewers and who has approved

### Fixes
- Agents no longer trigger false "responded" alerts
- Agents now keep their names
- Lost agents can be resumed

## [0.19.1] - 2026-10-05

### Features
- Click anywhere on a task row to open its details
- Resize the task detail drawer
- The task filter button now sits in the chip row
- Create a folder while making a new workspace
- Selected values in select menus stay pinned to the top of the list
- Remote: fit a terminal you're following to your current screen

### Fixes
- Dragging a tab or pane only pops it out into a new window once the pointer leaves the app
- Phone: the app fills the whole screen edge to edge, and you can now leave search
- Phone: the drawer scrolls and closes with a swipe
- Phone: the cursor stays above the on-screen keyboard
- Phone: close the full-screen palette with an X button instead of Cancel
- Phone: dialogs fit the screen, buttons are big enough to tap, and labels are readable
- Phone: card actions are evenly spaced, and the status bar is dark when installed as an app
- Phone: tighter app chrome, and the palette's scope picker has a proper label and size
- Web: reconnects as soon as the phone comes back
- Web: a chunk that fails to load is reloaded instead of leaving a blank page

### Improvements
- Faster first load on phones over the relay
- Smaller app download, because the bundled FiraCode Nerd Font was removed

## [0.19.0] - 2026-10-01

### Features
- Remote Control settings now use a single switch, with a QR code that opens Manor on your phone
- Reach your machine remotely over an end-to-end encrypted relay
- Use Manor in a browser, with a phone layout that shows one pane at a time
- Tasks now appear in command palette search results and share one detail view with the Tasks view
- In the palette, ⌘↵ starts a task and ↵ or → opens its details
- A scope chip in the palette picks which projects to search
- Linked checkouts appear as a single entry in the palette scope
- The Tasks view has a new detail drawer, uses the full window width and has editable filter chips

### Improvements
- Remote pairing now works only through the relay, and Tailscale support has been removed. Devices paired the old way must be paired again.
- The sidebar toggle is gone, and the notification bell has moved to the rail
- Removed "New agent here" from the task detail view
- Main content is now framed from the top of the window
- Hovered tabs below the active tab are now dimmed

### Fixes
- The workspace breadcrumb is back in the status bar
- The setup mini terminal now uses the theme of the workspace's project
- PR check badges now update correctly, counting only the latest run of each check

## [Unreleased]

### Breaking
- Tailscale tunnel support, the Watch and Reply device tiers and the lightweight phone client are removed. Remote control no longer opens any listener on your machine
- The Manor relay is now the only way to reach your machine. Turning remote control on only loads it; starting the relay is a separate, confirmed step
- Devices paired over Tailscale, or at Watch or Reply, are deleted the first time Manor starts after the upgrade and must be paired again through the relay
- Every paired device can now do everything the desktop app can; there are no read-only devices
- If you downgrade to an older Manor after upgrading, your devices must be paired again: the older build reads the new device entries as Tailscale devices, and this build then drops them

## [0.18.8] - 2026-09-30

### Features
- Panes whose SSH host is offline now show an overlay saying the host is away

### Improvements
- SSH hosts now look the same everywhere they appear in the app

## [0.18.7] - 2026-09-30

### Fixes
- Tasks for a linked group now load through any checkout that's reachable, even when another host is offline
- Fixed keyboard handling for terminal apps that use the kitty keyboard protocol

### Improvements
- Manor starts faster: the initial app bundle is smaller and first paint no longer waits for fonts to load
- Markdown rendering and diff syntax highlighting load only when first needed, reducing startup cost
- Pull request status checks are batched, and refreshes when the window regains focus are throttled, cutting GitHub API usage
- Agent status in sidebar rows and tabs now comes from a single shared source, so it stays consistent with less overhead
- Terminal pane info is now read from the terminal parser that's already running, which lowers background CPU use
- Port scanning is faster because it no longer starts a separate process for each running program

## [0.18.6] - 2026-09-30

### Fixes
- The sidebar PR badge now shows on the main checkout when it's on a branch other than the default

### Improvements
- Faster startup: the updater, remote control and web push now load only when needed, the login PATH resolves in the background, and post-launch work runs in parallel
- Checking for diff changes stays fast as you add more workspaces
- The terminal daemon now writes to disk in the background, so terminals stay responsive, and it no longer leaks resources
- Fewer unnecessary UI re-renders, including when animated spinners update terminal titles and when you switch pane focus
- The dashboard, the "Needs you" card and the popover badge now show the same pull request status and what's blocking it

## [0.18.5] - 2026-09-29

**Features**
- Project header actions in the sidebar now appear when you hover over the header
- Linked project groups in the sidebar now show header actions too

**Improvements**
- Sidebar header actions now fade in instead of sliding in
- The sidebar header's hover highlight now appears in step with the action buttons

## [0.18.4] - 2026-09-29

**Features**
- You can now filter and sort the Up next list on the Home screen, the same way you can in the Tasks view

## [0.18.3] - 2026-09-29

### Fixes
- File links in the terminal now open in your editor only when you hold Cmd (macOS) or Ctrl while clicking, so a plain click no longer opens files by accident.

## [0.18.2] - 2026-09-29

### Features

- The dashboard greets you by time of day, and its headline is warmer and changes more often
- The dashboard's "Up next" section now shows items from your Tasks list

### Improvements

- Dashboard card buttons are smaller
- The dashboard's "Review" status is now cyan

## [0.18.1] - 2026-09-29

### Features

- Filter and sort tasks in the Tasks view
- The Open, Assigned and In progress toggle is replaced by default filters you can change
- The Tasks view gets more details for GitHub and Linear tasks, so there are more fields to filter and sort by

### Fixes

- Manor stops requesting GitHub project data after it detects that your token lacks the `read:project` permission

### Improvements

- The Tasks view has better spacing, and the tracker tabs and project picker now sit in the search row
- The Refresh button is removed from the Tasks view

## [0.18.0] - 2026-09-29

### Features
- The Home page is now a Dashboard with stat tiles, "Needs you" cards, a PR pipeline, an "Up next" panel and project tiles
- Added an agent activity timeline that keeps its history between app restarts
- Hover over a PR or workspace on the Dashboard to see a detail popover
- "Needs you" cards can be snoozed, and every blocked PR card now has a "Fix with agent" action
- Added a Tasks page (formerly Issues) with a table, filters, pagination and author/assignee details
- The Tasks "In progress" filter shows tasks linked to workspaces, and other views hide tasks that already have a workspace
- Added a dedicated "Up next" view in the command palette for starting work quickly
- Added a Search row to the sidebar that opens the command palette
- The command palette now has go-to destinations and the same commands as the app menus
- Command palette search can be limited to the current project with a scope chip, or widened to search everything
- Removed the Projects page, and Tasks now fills the full dashboard column
- The notifications bell is back at the right edge of the sidebar

### Fixes
- Pressing Escape in the command palette now clears the scope chip instead of closing the palette
- The sidebar always shows the workspace branch
- An agent's launch prompt now goes to its new tab instead of the workspace
- Agents now start alongside a workspace's setup script instead of being dropped
- Live agent sessions now show up to the current moment on the timeline, a new agent gets its first status, and stopped agents settle correctly
- The Tasks table now scrolls under a sticky header instead of squashing rows
- Open PR rows keep enough room to show the PR title

### Improvements
- Redesigned the sidebar: navigation is separate from content, text uses one size scale, labels are no longer all caps, and icons line up
- PR pipeline stages scroll instead of hiding cards, and "Up next" now sits above PRs
- All "Needs you" card actions are the same size and no longer overflow the card footer
- The Dashboard no longer has tabs, agent launchers or its own settings page

## [0.17.0] - 2026-09-28

### Features
- New window frame: tabs now sit in the title row, and panels have rounded, inset bodies
- The sidebar now animates when switching between full, rail, and hidden modes
- Collapsible sections now animate when opening and closing

### Fixes
- Command palette items no longer get confused when two items have the same label
- Queued terminal commands now wait for the shell prompt before they're typed
- The status bar now shows Projects on the overview instead of the trail of the workspace behind it
- Agents and Ports now fold from their dragged height instead of snapping open first
- Dragging a folded Agents or Ports section now slides it open from zero
- Sidebar no longer scrolls sideways when collapsible sections are open
- The sidebar toggle reopens from the rail and shows the correct icon when collapsed
- Sidebar guide color and host heading spacing are restored

### Improvements
- The project list fades at its edges instead of cutting rows off
- Resize handles for the sidebar, Agents and Ports now look the same, with an accent glow that fades at the ends
- Count badges look the same everywhere in the app
- A connected cloud host now shows as a subtle blue chip
- The tab bar was restyled: top accent border on the active tab, rounded corners, tighter spacing and a square New Tab button
- The collapsed sidebar rail is better aligned under the traffic lights, with even spacing, a faint Home button background, and the Agents button directly below the project tiles
- Rail and PR popovers now wait a moment on hover before opening, so they don't pop up by accident
- The title row is cleaner, and the notification bell has moved to the top-right corner
- The Projects overview is now centred vertically
- The sidebar and its sections are cleaner, with fewer borders and backgrounds and a thinner divider between panels

## [0.16.1] - 2026-09-28

### Fixes
- Agents running long tool calls now keep showing as working instead of dropping out of that state partway through.

### Improvements
- The pulsing status dots now animate the same way everywhere they appear.

## [0.16.0] - 2026-09-28

### Features
- New Home dashboard with a "Needs you" section, an "Up next" list built from your assigned GitHub issues, and a summary line
- New Projects overview with project cards, onboarding for first-time users, and a sidebar entry to open it
- Create a project by cloning a repository onto any host, including this machine
- The Add Project dialog lists your GitHub repositories so you can pick one to clone
- Add a project from a card in the Projects overview grid; this replaces the drop zone
- The sidebar can collapse into a compact rail of project tiles
- Hover a project tile in the rail to see its full sidebar entry in a popover
- The rail has an Agents popover that shows the sidebar's agents panel
- Drag the sidebar edge past its minimum width to collapse it to the rail, and drag the rail's edge to expand it again
- The Agents pane in the sidebar is now collapsible, and the collapsed state of the Agents and Ports panes is remembered between sessions

### Fixes
- Agents recorded without a project are now matched to their project instead of being listed under "Unknown"
- Agent status dots in the modal now pulse the same way as in the sidebar
- The Home empty state no longer shows while issues are still loading
- Close shortcuts no longer act on content hidden behind the overview
- The Agents pane header and spacing now match the Ports pane

### Improvements
- The sidebar and the rail share one resize edge, so resizing and collapsing feel the same in both
- The rail popover is wider and switches between tiles instantly, and tile tooltips are gone
- The rail's Agents icon no longer shows a count
- Idle agents you've already read now show a plain outline ring
- Trimmed the launchers on the Home screen

## [0.15.1] - 2026-09-28

### Features

- Linked projects now share a theme and commands across the whole group
- Linked project settings now open on a group page, with a nested page for each member
- Added "Choose local folder…" when linking a remote project
- Linked hosts now appear in the sidebar as small-caps section headings
- A host's status dot now appears only while that host is away
- Folders now use open and closed icons instead of a chevron
- Project contents now hang off a guide line, which is colored for the selected project
- The project menu is back on linked project headers, and host section menus are simpler

### Improvements

- Cleaner sidebar layout: projects are separated by spacing and font weight, and workspaces are indented
- Project names no longer show icons or partial/offline badges
- Folder headers no longer show a workspace count
- Collapsed folders no longer show idle status
- The Projects heading now uses the folders icon, and Home is styled to match it
- Better spacing and padding across the sidebar and host sections
- Host labels in settings now line up, and the linked projects list is more polished
- The host toggle for a new folder now always shows, sits under the name, has a host already selected and uses plain host labels

## [0.15.0] - 2026-09-28

### Features
- Link two projects into a group that appears as one entry in the sidebar
- Manor suggests linking projects that share the same origin URL, and suggests again when a host connects
- Linked groups show the status of each host
- Shared settings now live on the project group
- Pick a host in the New Workspace dialog
- Clone a project onto another host from the host picker
- Select multiple workspaces in the sidebar with Cmd/Ctrl-click and Shift-click
- Right-click a multi-selection to delete it, hide it, or move it to a folder
- Drag a multi-selection into and out of folders
- Multi-select works across a group's host sections
- Run the `manor` CLI from remote hosts, with a hint when a remote session starts
- The CLI can list groups and create workspaces on a chosen host with `--host`
- Workspaces created from the CLI record the group's last-used host

### Fixes
- New terminals open on the host they were requested for
- Agents now follow the host their terminal runs on
- Saved layouts, the GitHub cache and portless hostnames are kept separate per host, so workspaces with the same path on different hosts no longer collide
- Workspace context now matches on both host and path
- A remote project's main workspace is named after its host
- The active row is highlighted only in its own host's section
- A workspace whose removal failed is no longer left dimmed
- PR badges stay in place when a workspace is removed
- Cmd/Ctrl-click keeps the clicked row selected
- A closed link summary stays closed
- Diff selection is kept when using the arrow keys
- Malformed agent records no longer break the group agent count

### Improvements
- CLI errors show a readable message instead of raw JSON
- Commands relayed from a remote host are limited to that host
- `--host` accepts the local host's label

## [0.14.5] - 2026-09-27

### Features
- Paste clipboard images into agents running on remote hosts
- Manor now checks remote host connections with a heartbeat and re-checks them when your Mac wakes from sleep
- Main-process logs are now saved to a rotating log file to make troubleshooting easier

### Fixes
- PR badges and GitHub issues now show for remote projects
- The sidebar now updates remote projects when worktrees change outside Manor
- A slow request no longer drops a remote connection; Manor checks whether the host is still reachable first
- Linked GitHub issues in the status bar load reliably, and a failed load now shows up right away instead of hanging

## [0.14.4] - 2026-09-27

### Fixes
- Agent panes now stay in the working state while background subagents are still running.
- Foreground subagents get more time before they are flagged as stuck.
- Terminal sessions now survive app updates. The background daemon only restarts when an update changes its protocol.
- Agents cut off by a daemon restart are no longer marked as completed.

## [0.14.3] - 2026-09-27

### Features

- The PR badge and popover now show when a pull request has merge conflicts
- Agents whose output you've already read now show as a still gray ring on the agent status dot

### Fixes

- The sidebar now updates when worktrees are added or removed outside Manor
- Agent status now picks back up when a turn continues after Manor had marked it as stuck and ended it

## [0.14.2] - 2026-09-26

### Features
- Move a project to a different host from Project Settings, with a new Clone to Host dialog
- Manor remembers each project's path on every host and follows the project when you switch hosts
- One host indicator is now shown the same way everywhere in the UI
- The agent status tooltip now shows why an agent has its current status, such as what it's thinking about
- A pane now shows when a child agent session needs your input

### Fixes
- Bash panes now report their working directory, so new panes and splits open in the right folder
- Bash startup settings are now only loaded in bash panes
- Pane agent status is restored correctly after Manor restarts
- A new agent is named from its pane's title as soon as it's created

### Improvements
- Agent status is more accurate and consistent, and the separate "complete" state has been removed
- Remote hosts are more reliable: commands wait in a queue until they are delivered, and config files are saved safely
- Remote pane and browser URL handling is more consistent across hosts
- Error messages are clearer when working with remote hosts

## [0.14.1] - 2026-09-26

### Fixes
- Release builds now include the manor-host component, so features that depend on it work in the shipped app

## [0.14.0] - 2026-09-26

### Features
- Run projects on remote hosts over SSH, with terminals, git, and agents running on the remote machine
- Add and monitor remote hosts from a new host management UI
- Add a project on a remote host by cloning it or adopting an existing clone, with a health check
- Manor installs its host service on remote machines and keeps its version in step with the app
- Agent hooks work on remote hosts, and events that happen while you're disconnected are replayed when you reconnect
- Remote projects show a Disconnected state, reconnect on their own, and resume sessions after the remote host restarts
- Port scanning and port forwarding work for remote projects on Linux hosts
- Start new agent sessions from your phone and pick which workspace they launch in
- Phone remote view now shows the terminal row for row, the same as on desktop

### Fixes
- Restoring a saved layout no longer breaks when selection IDs are missing
- Agent sessions now correctly detect the agent type, on both local and remote projects
- A new session started from your phone now opens that session
- Startup commands in new terminals no longer fail on a race
- The remote host restart notice now stays on screen long enough to read
- Remote port forwards only listen on localhost, and forwards are cleaned up properly when a project closes
- Unreadable agent config files on remote hosts are no longer overwritten

## [0.13.2] - 2026-09-18

## Features

- Full keyboard navigation: F6 cycles focus regions, sidebar rows and tab bar support roving focus, Enter opens, F2 renames
- Open context menus from the keyboard
- Keyboard shortcuts now work in browser panes and popout windows
- Keyboard access for secondary surfaces: ports, PR badge, processes, recorder, theme picker, welcome screen, and toasts
- Dialogs restore focus on close and scope shortcuts correctly behind modals
- Agent launches now report a confirmed pane ID from the agent and batch routes
- New orchestrator primer and fan-out playbook surfaced at session start

## Fixes

- Escape on the PR popover no longer reopens it
- Sidebar and rename input take focus before the next keypress arrives
- Multi-line agent prompts are flattened so they launch reliably

## Improvements

- Visible focus rings and proper labels across interactive controls
- More reliable agent launch targeting via an explicit target in the app-command table

## [0.13.1] - 2026-09-16

### Features
- Clicking the status bar issue indicator now opens the issue directly when the workspace has only one linked issue

### Fixes
- Large files in the diff viewer no longer crash by hitting React's update depth limit
- Sidebar diff stats now stay visible after a project reloads
- Empty PR comment notifications are now hidden

## [0.13.0] - 2026-09-14

### Features
- Emoji shortcode autocomplete in text fields: type `:` to get emoji suggestions next to your cursor
- Emoji autocomplete in workspace and folder names, commit messages, feedback and review comments
- Emoji are removed from branch names generated from workspace names
- Status bar breadcrumbs now show folder names
- Workspace menu has a new Copy submenu that includes the PR link
- Command palette search now includes the commands you use most
- Stats streaks now count active weeks instead of days

### Fixes
- Nested folders in the sidebar can now be reordered by dragging
- Diff search highlights no longer leave stray characters behind
- Selects in the New Workspace dialog are no longer cut off
- Keyboard shortcuts with modifier keys now work while emoji suggestions are open

## [0.12.1] - 2026-09-12

### Improvements

- External links in Settings, the About modal, nudges, port links, PR popovers and comment cards now open in your default browser.
- Removed the update section from the About modal.

## [0.12.0] - 2026-09-12

**Features**
- Comment on any diff by selecting text — a floating Comment chip turns the selection into an inline comment
- Batch inline comments into a single review and send it to an agent, with a destination picker for where it goes
- Jump straight to any comment from the review bar's tally
- Nested folders in the sidebar — drag to reorganize and create folders inside folders
- PR badge now shows a quiet pending state and flags when a PR needs review
- Press Enter to rename in the sidebar; the sidebar keeps focus while you work

**Fixes**
- Review prompts no longer assume you're asking for a code change
- Comment chip now lines up with the text you selected
- Review bar no longer overlaps the back-to-top button
- Comment anchors stay correct across files
- Sidebar highlight now follows the open workspace, and the focus ring appears on click
- Right-clicking during a rename no longer closes the input

**Improvements**
- Diff pane no longer re-renders itself every five seconds
- Comment chip stopped re-scanning the file on every frame
- Review bar reordered, with a smaller Discard button

## [0.11.3] - 2026-09-10

## Features
- Agents section in the sidebar can now be resized vertically
- PR badge icon now reflects the pull request's status at a glance
- Merged PRs now count toward the Shipper stat
- Settings search jumps straight to any section, matches whole categories, and focuses automatically when the modal opens
- Notification comment previews now render as PR comment cards
- Notifications filter out bot and self-authored PR comments

## Fixes
- Agents no longer get stuck showing "requires input"
- Repos without CI are now correctly marked ready to ship
- Agent stats count only busy agents and ignore non-root sessions
- Projects list fills the available sidebar height
- New workspace dialog keeps its footer buttons inside the dialog

## [0.11.2] - 2026-09-08

**Features**
- The changelog now opens automatically on first launch after an update
- Added an in-app changelog to the About window, replacing the inspired-by list

**Fixes**
- PR popover shows full comment text, collapsing only resolved threads
- Native scrollbars now match the active theme
- Sidebar shows queued PR state, with colour applied to just the badge icon

## [0.11.1] - 2026-09-08

### Features
- Send content from the sidebar directly to an agent
- Select folders directly from the sidebar

### Improvements
- PR badges now show queue state and colour-coded CI status
- HTML comments render correctly in the sidebar

## [0.11.0] - 2026-09-07

### Features

- Native macOS application menu with File, Edit, View, Workspace, Pane, Agents, Window, and Help menus
- Settings… now appears in the app menu
- Keyboard shortcuts are displayed live in the menu and update immediately when rebinding in Settings › Keybindings
- New shortcuts for workspace navigation: `Ctrl+Cmd+↓` (Next workspace) and `Ctrl+Cmd+↑` (Previous workspace)
- New `manor` CLI installed to `~/.manor/bin` (replaces `manor-webview`), generated from the MCP tool modules and advertised to Claude Code at session start
- Control surface: HTTP routes and MCP tools for projects, workspaces, folders, tabs, panes, agents, git, system, and integrations
- Diff editor renders changed files as a nested folder tree with per-extension icons
- Agents can be renamed inline; a custom name is kept over the synced title
- Stats track mid-thought kills as a separate "Derailed" counter
- PR popover shows skipped checks, renders markdown comments, and has collapsible sections

### Fixes

- PR polling no longer burns through the GitHub GraphQL rate limit
- Escape cancels a workspace or folder rename instead of committing it
- Diff pane sticky header no longer renders above popovers
- Control routes return 404 for unknown folder or workspace ids; CLI accepts literal `true`/`false` after boolean flags
- Removed the "Agent completed" toast

### Improvements

- Zoom now applies to the focused window instead of always zooming the main window
- Reload and Force Reload removed from packaged builds to reduce accidental data loss
- Stats view: aligned dot leaders, label tooltips, wider kill rule, and 1-minute fast unblocks
- Stats icon in the status bar rests at the same opacity as its neighbours

## [0.10.3] - 2026-09-06

### Features

- PR popover now shows recent comments, review threads, and named check runs

### Improvements

- Unread notifications use a yellow dot, badge rows open the stats view, and the stats view has more room

## [0.10.2] - 2026-09-06

### Fixes

- Manor now recovers gracefully if the terminal-host daemon crashes or is lost, instead of leaving sessions broken

## [0.10.1] - 2026-09-06

**Features**

- Stats view now includes a contribution graph and an achievements rack

## [0.10.0] - 2026-09-06

## Features

- Workspace folders — group workspaces in the sidebar, collapse them, and move workspaces in or out
- Create a new workspace directly inside a folder from its context menu
- Drag workspaces into folders anywhere in the sidebar with a wider, steadier drop target
- Stats tracking with a stats palette view, status bar segment, and a settings toggle to turn it on or off
- Badges that unlock as you work, with a notification when you earn one
- Frequently used commands now pinned to the top of the command palette
- PR comments expand on hover in notifications, and the row names who commented

## Improvements

- Sidebar workspace indicator dots redesigned — PR badges are now colored by readiness and the corner dot is gone
- "Tasks" renamed to "Agents" throughout the app
- Tighter folder spacing, aligned folder member icons, and empty folders no longer take up space

## [0.9.0] - 2026-08-25

**Features**

- Notification badges, icon actions, and filtering by notification kind

**Fixes**

- Terminal panes now size correctly on first paint — font loads before measuring
- Smoother pane resizing with no visual flicker

## [0.8.0] - 2026-08-23

**Features**

- Remote control: pair your phone and monitor sessions live from a mobile web client, with push notifications when an agent needs input or errors
- Stop a running agent or answer a prompt from your phone in a single tap
- Remote-control settings page to enable access, pair devices, review exposure, and start a Tailscale or cloudflared tunnel on demand
- Installable phone client (add to home screen on iOS)
- Notification center: a bell in the sidebar titlebar with full notification history behind it, persisted across restarts

**Fixes**

- Sessions that already need input when opened now notify you
- Read state now reflects what's actually on screen, not just clicking a task
- Popout windows no longer tear down mid-drag
- Phone client no longer loses focus and scroll position on every refresh
- Tightened remote-control auth: tokens verified before backoff, rate limiting only on authenticated requests, session IDs constrained to a single path segment

**Improvements**

- Consolidated remote-control routing, writes, and status ownership behind a single path
- Unified relative-time formatting across the app

## [0.7.0] - 2026-08-23

## Features

- Every workspace now stays mounted, so switching between them is instant and no longer duplicates terminal output
- Sessions that no longer exist now report cleanly as "not found" instead of surfacing an error

## Fixes

- Fixed duplicated terminal output when restoring a session after reconnecting
- Restored sticky file headers in the diff view
- Reading a session now works for plain terminal panes
- The app negotiates a protocol version with the background daemon, preventing breakage when versions differ

## [0.6.5] - 2026-07-27

**Features**

- Record terminal sessions with a live recording indicator on the pane
- Start, stop, and list recordings from MCP tools

**Fixes**

- Sidebar: clicking to add a tab no longer misbehaves

## [0.6.4] - 2026-07-25

## Features

- Pop a pane out into its own window from the context menu

## Fixes

- Keyboard shortcuts now work in popped-out windows

## [0.6.3] - 2026-07-25

**Features**

- Toggle named preview URLs per project
- Home surface (renamed from Orchestrator) with a real working directory and prewarming
- Navigation history: back/forward through views with Cmd+Ctrl+[ and Cmd+Ctrl+], plus titlebar buttons
- Tear off a tab into its own floating window, and drag it back to reattach
- "Move Tab to New Window" menu item
- Drag panes out of a split into a new window with native drag-and-drop
- Tab context menu: Close Others and Close to the Right, with shortcut hints
- Orchestrator tools: list running tasks, send input to a session, and read session output
- Orchestrator settings and harness preferences
- `screenshot_webview` can now save a PNG to disk

**Fixes**

- PR notifications no longer get dropped while a webview has focus
- Home is restored as the active surface after relaunch
- Detached windows no longer open empty or refuse to move
- Empty-workspace views are recorded and replayed correctly in history

**Improvements**

- Status bar drops back/forward buttons in favor of a Home label
- Load-more control in tasks no longer looks like a button

## [0.6.2] - 2026-07-08

**Features**

- Browse and read Linear issues directly in Manor, alongside GitHub issues
- View full issue details without leaving the app
- New MCP tools for pane control: split a pane, open a terminal, open a browser
- New MCP tool to report the current workspace and project context
- Creating a workspace now runs the project's setup script, and the workspace name is optional

**Fixes**

- Issue lists no longer silently come up empty when the `gh` CLI fails — errors now surface
- The sidebar refreshes when projects change from an MCP action
- Linear issue identifiers are accepted in lowercase
- Failures when assigning or closing an issue are now reported instead of silently ignored
- Failures when unlinking an issue now surface in the popover and detail view

**Improvements**

- Pane tools act on the pane that invoked them rather than stealing your focus
- Consistent error messages across issue views

## [0.6.1] - 2026-07-08

- Manor now includes MCP tools for managing projects and workspaces
- Orchestrate agents directly through MCP with new `list_issues`, `start_agent`, and batch workspace creation tools
- Get desktop notifications when your pull requests receive updates and events
- Added settings toggles to control which PR notifications you receive
- PR badges and popovers now show comment counts

Fixes

- PR badges and popovers now update live as pull request fields change

## [0.6.0] - 2026-07-03

Features

- Add setup and teardown scripts as re-runnable commands in the command palette
- Reorder project commands by dragging them in settings

Fixes

- Dismiss the "checking for updates" toast once an update is found
- Open the SearchableSelect menu with the ArrowDown key when its trigger is focused
- Hide Merge & Delete actions for pull requests that are already merged
- Keep workspaces dimmed while a full deletion is in progress

## [0.5.13] - 2026-06-17

Features:

- Browser popups that communicate with their opener now open in a managed child window
- Links set to open in the background now correctly open in a new background tab

Fixes:

- Popups and new windows now open reliably using native window handling
- The browser now opens explicit `file:`, `data:`, and `about:` URLs directly instead of running a search
- Browser popups no longer fail to open due to an incorrectly formatted setting
- Shell sessions no longer leak history into the wrong file, and now run `.zlogout` cleanly on exit
- Nested terminal launches no longer break shell environment setup
- Webview automation now reconnects correctly after Manor restarts
- The diff watcher no longer errors on directories that aren't git repositories

## [0.5.12] - 2026-06-12

**Features**

- Sessions now automatically resume where they left off when relaunching the app
- Default branch is detected when a project is created and re-checked at startup to catch drift

**Fixes**

- Branch name casing is now preserved instead of being normalized
- Resume commands now preserve custom flags and no longer append duplicate arguments
- Shell history now respects your global HISTFILE setting instead of overriding it

**Improvements**

- Branch names are handled consistently across the app
- Remote branch lists now refresh origin/HEAD for more accurate default-branch detection

## [0.5.11] - 2026-06-05

Features

- Search terminal scrollback with cmd+f
- Hide and unhide workspaces from the sidebar
- Share a single zsh history file across all panes

Fixes

- Diff view now sizes to full content instead of being capped by a max height
- Hidden workspaces submenu now matches the workspace-list layout

## [0.5.10] - 2026-06-01

**Features**

- Right-click the Projects header in the sidebar to open a context menu

**Fixes**

- Orphaned active tasks no longer linger in the sidebar
- Fixed pane ownership not transferring correctly when creating a task

## [0.5.9] - 2026-06-01

Features:

- Add a "New Project" command to the command palette
- Open the new workspace dialog with a playful empty state when a search returns no results

Fixes:

- Reliably focus the name input when opening the new workspace dialog

Improvements:

- Always keep the Projects section expanded in the sidebar and remove the collapse toggle
- Streamline the sidebar by removing add buttons and tidying the diff file list layout

## [0.5.8] - 2026-05-03

### Features

- Check for Updates menu item in native app menu
- AboutModal now shows Check button, last-checked time, and restart row
- Toasts gain secondary action button and dismiss control

### Improvements

- Update notifications surface via toasts with live status
- Faster, more reliable update checks with periodic background polling

## [0.5.7] - 2026-05-02

Features

- Stream `git push` output live with progress toasts in DiffPane
- Click toasts to expand and view full push output, with auto-expand on errors

Improvements

- Cancel in-flight pushes from the UI
- Clearer push error messages via categorized failure types

## [0.5.6] - 2026-05-02

### Fixes

- Late hook events on responded sessions now dropped correctly

### Improvements

- Hook event handling refactored with typed events and pure state transitions for reliability

## [0.5.5] - 2026-04-29

### Features

- Diff pane: sticky action bar, sidebar layout at wide widths, grouped push+commit action
- Task list: pagination with retention pruning for faster loads
- Working directory now refreshes live from terminal `cd` events

### Fixes

- Generic terminal notifications no longer flip task status incorrectly
- Recover stuck "requires input" tasks during sweeps, bridge handoff, and replacement
- Hook events buffered until the relay connects, preventing lost signals
- Pending Stop signals now apply before sessions transition to completed
- Stale task reconciliation now keys off paneId instead of agent session ID
- Skip spurious agent-detection flip on session start

### Improvements

- More robust hook script (Node-based JSON parsing replaces bash)
- Atomic write for `~/.manor/hook-port` to avoid partial reads
- Validate `agentKind` values and inject `MANOR_AGENT_KIND` per connector
- Monotonic clock for idle sweep math (immune to wall-clock jumps)
- Main process is now authoritative for unseen flags and `resumedAt` timestamps
- Atomic task navigation via a single store action
- Allowlisted fields for `tasks:update` IPC for tighter safety
- O(1) task lookups via id-index
- Removed dead `unlinkPane` code path

## [0.5.4] - 2026-04-22

**Features**

- Duplicate tab now preserves the full pane layout
- Push button added to the diff pane for pushing commits directly from Manor
- Auto-resume active Claude sessions after Manor restarts
- Background setup scripts show a persistent toast and can be reattached via MiniTerminal
- Better tracking of agent subagent start/stop activity

**Fixes**

- Fixed a race when creating new terminals that could miss the initial working directory
- Unified agent status across the tab bar and sidebar
- Orphaned daemon sessions now appear in the Processes view
- Daemon sessions survive version upgrades via a stable socket path
- Task-input toast clears on sidebar navigation; diff watcher quieter for local-only repos
- Previous pane task is properly unlinked on auto-resume
- Handle PTY creation failures gracefully in the terminal lifecycle
- Corrected agent title and status handling
- Commit modal keeps its own state instead of relying on a toast

**Improvements**

- Stale and orphaned tasks are now reconciled on startup and when panes close
- More reliable detection of finished agent runs with inactivity and gone-state sweeps
- Cleaner shell environment inheritance for spawned terminals
- Existing worktrees are handled more gracefully
- Centralized filesystem paths for a more consistent ~/.manor layout

## [0.5.3] - 2026-04-11

**Features**

- Add restart button for portless proxies in the Processes view

**Fixes**

- Include local branches in the existing branch dropdown when creating workspaces
- Clear stale greyed-out state when workspaces change
- Pass base branch and existing branch options through the full worktree creation flow
- Unpack MCP webview server from asar so agents can read it
- Use React state for favicon error handling instead of imperative DOM manipulation
- Fix panel layout crash by keying on workspace path

**Improvements**

- Add recursion guard and fail-fast to uncaught exception handler

## [0.5.2] - 2026-04-07

**Fixes**

- Reset terminal now properly kills the old shell and starts a fresh session
- Startup commands no longer fire before the shell is ready
- Feedback dialog automatically focuses the title field when opened

**Features**

- Screenshots now render inline in Linear ticket detail view

## [0.5.1] - 2026-04-06

**Features**

- Pre-warmed terminal sessions for instant new task startup
- Agent command injection during prewarm for faster session initialization

**Fixes**

- Fixed macOS notification permissions not registering correctly
- Fixed agent command not starting in certain prewarm scenarios
- Fixed potential blocking when writing to prewarmed sessions

## [0.5.0] - 2026-04-06

**Features**

- Add process kill support from the command palette
- Add confirmation dialog for "Kill All" action
- Add "New Workspace" action to the local workspace empty state
- Add processes management to the command palette
- Add colored bottom borders to tabs by content type
- CMD+click on file paths in the terminal now opens them in your editor
- Tasks now display a unified title and status from agent streams

**Fixes**

- Fix garbled and wavy text in terminal rendering
- Fix errors when the daemon is unreachable and empty filter edge case
- Fix dock badge notification dot appearance
- Fix periodic page refreshes caused by proxy server timeouts

## [0.4.2] - 2026-04-05

**Improvements**

- Added a helpful hint when prompted to save your Linear API key to the keychain

## [0.4.1] - 2026-04-05

**Features**

- Added a keyboard shortcut to open diffs directly from the terminal
- Added a toggle in General Settings to configure diff behavior

## [0.4.0] - 2026-04-05

**Fixes**

- Fixed WebGL text rendering glitches after resizing the terminal
- Updated app icon with correct colors
