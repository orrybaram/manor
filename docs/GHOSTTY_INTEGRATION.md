# GhosttyKit Integration Plan

## Goal

Replace Manor's custom terminal stack (ANSI parser, cell grid, PTY, Core Text rendering, input routing) with GhosttyKit — Ghostty's battle-tested terminal engine that renders via Metal directly into an NSView's CALayer.

Manor keeps its window management, tab bar, and pane split tree.

## Reference Project

**cmux** — [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)
- Native macOS AppKit terminal using GhosttyKit
- Key file: `Sources/GhosttyTerminalView.swift` (~8500 lines, contains GhosttyApp, TerminalSurface, GhosttyNSView)
- Uses bridging header (`#import "ghostty.h"`), no module map
- Ghostty as git submodule, built via Zig into xcframework

Also see: [awesome-libghostty](https://github.com/Uzaaft/awesome-libghostty)

## What Gets Replaced

| Manor File | Replaced By |
|---|---|
| `Terminal/TerminalEmulator.swift` | libghostty internals |
| `Terminal/TerminalState.swift` | libghostty internals |
| `Terminal/PTY.swift` | libghostty PTY management |
| `Views/TerminalView.swift` | GhosttySurfaceView (Metal rendering) |
| `Input/InputRouter.swift` | Direct `ghostty_surface_key()` calls |

## What Stays

- `App/AppDelegate.swift` (modified to init GhosttyApp)
- `App/ManorWindowController.swift` (modified to use GhosttySurfaceView)
- `App/ManorApp.swift` (entry point, no changes)
- `Views/PaneContainerView.swift` (modified to host GhosttySurfaceView)
- `Views/TabBarView.swift` (no changes)
- `Models/PaneModel.swift` (minimal or no changes)

## New Files

| File | Purpose |
|---|---|
| `Ghostty/GhosttyApp.swift` | Singleton: `ghostty_init` → `ghostty_config_new` → `ghostty_app_new` with runtime callbacks |
| `Ghostty/GhosttySurfaceView.swift` | NSView with CAMetalLayer, hands pointer to `ghostty_surface_new`, routes key/mouse events |
| `Ghostty/GhosttyCallbacks.swift` | `@convention(c)` callback functions for wakeup, actions, clipboard, close |
| `BridgingHeader.h` | `#import "ghostty.h"` |

## GhosttyKit C API Overview

### App Lifecycle
```swift
ghostty_init(argc, argv)
let config = ghostty_config_new()
ghostty_config_load_default_files(config)
ghostty_config_finalize(config)

var rt = ghostty_runtime_config_s()
rt.wakeup_cb = { _ in DispatchQueue.main.async { GhosttyApp.shared.tick() } }
rt.action_cb = { app, target, action in /* handle splits, title, notifications */ }
rt.read_clipboard_cb = { /* NSPasteboard read */ }
rt.write_clipboard_cb = { /* NSPasteboard write */ }

self.app = ghostty_app_new(&rt, config)
```

### Surface Creation
```swift
var sc = ghostty_surface_config_new()
sc.platform_tag = GHOSTTY_PLATFORM_MACOS
sc.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(
    nsview: Unmanaged.passUnretained(view).toOpaque()
))
self.surface = ghostty_surface_new(app, &sc)
```

### Input
```swift
var keyEvent = ghostty_input_key_s()
keyEvent.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
keyEvent.keycode = UInt32(event.keyCode)
keyEvent.mods = modsFromEvent(event)
text.withCString { ptr in
    keyEvent.text = ptr
    ghostty_surface_key(surface, keyEvent)
}
```

### Resize
```swift
ghostty_surface_set_content_scale(surface, xScale, yScale)
ghostty_surface_set_size(surface, widthPx, heightPx)
```

### Action Callback (Ghostty → Swift)
```swift
switch action.tag {
case GHOSTTY_ACTION_NEW_SPLIT:    // create new pane
case GHOSTTY_ACTION_SET_TITLE:    // update tab title
case GHOSTTY_ACTION_COLOR_CHANGE: // update background
case GHOSTTY_ACTION_CLOSE_SURFACE: // remove pane
// ~30 more actions
}
```

## Phases

### Phase 1: Infrastructure ✅ DONE
- [x] Add Ghostty as git submodule at `vendor/ghostty`
- [x] Create bridging header (`Sources/ManorApp/BridgingHeader.h`)
- [x] Add Makefile target to build GhosttyKit via Zig (`make ghostty`)
- [x] Update Makefile compile/link flags
- [x] Verified build succeeds — binary links against libghostty.a (272MB static lib)

Build command: `cd vendor/ghostty && zig build -Dapp-runtime=none -Demit-xcframework=true -Doptimize=ReleaseFast`
XCFramework location: `vendor/ghostty/macos/GhosttyKit.xcframework/macos-arm64_x86_64/`
Headers: `...Headers/ghostty.h` (C API, exposed via bridging header)

### Phase 2: GhosttyApp Singleton ✅ DONE
- [x] Create `Ghostty/GhosttyApp.swift` — singleton with init, config, runtime callbacks
- [x] Create `Ghostty/GhosttyCallbacks.swift` — C callback functions for wakeup, action, clipboard, close
- [x] Create `Ghostty/GhosttySurfaceView.swift` — NSView with CAMetalLayer, key/mouse input routing
- [x] Build verified — binary links and compiles (16.9MB with libghostty)

### Phase 3: Surface View ✅ DONE (merged with Phase 2)

### Phase 4: Wire Into Manor ✅ DONE
- [x] Modify PaneContainerView: TerminalView → GhosttySurfaceView
- [x] Modify ManorWindowController: remove InputRouter, use surfaces, implement GhosttyAppDelegate
- [x] Wire action_cb for ghostty-initiated splits/titles/close
- [x] Init GhosttyApp.shared in AppDelegate
- [x] App-level keybindings (Cmd+D/T/W) intercepted before reaching ghostty surface

### Phase 5: Cleanup ✅ DONE
- [x] Deleted TerminalEmulator.swift, TerminalState.swift, PTY.swift
- [x] Deleted TerminalView.swift, InputRouter.swift
- [x] Removed Terminal/ and Input/ directories
- [x] Moved KeyAction enum into ManorWindowController.swift
- [x] Build verified — 16.8MB binary, clean compile

## Risks & Notes

- **Metal layer**: GhosttySurfaceView must override `makeBackingLayer()` → CAMetalLayer BEFORE `ghostty_surface_new()`
- **Keybinding conflict**: Manor's app shortcuts (Cmd+D/T/W) need to be intercepted before reaching the surface, or configured in ghostty config to forward as actions
- **Retina**: Must pass correct `backingScaleFactor` and update on display changes
- **Swift 6 concurrency**: C callbacks fire on background threads — need `DispatchQueue.main.async` bridging
- **Build dependency**: Requires Zig installed to build GhosttyKit
- **No SPM**: GhosttyKit is not available as a Swift Package — must build from source via Zig
