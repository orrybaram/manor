# Changelog





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
