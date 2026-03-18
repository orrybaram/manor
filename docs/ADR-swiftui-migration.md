# ADR: Migrate UI from AppKit to SwiftUI

## Status
Accepted

## Context

Manor's UI is built with AppKit (`NSView` subclasses + delegate protocols). This worked for initial development but has become difficult to maintain because:

1. **`ManorWindowController` is a god object** — it holds all app state, handles all events, and manually syncs UI after every mutation. Every change requires calling `refreshLayout()`, `refreshSidebar()`, and updating delegate properties by hand. There is no unidirectional data flow.

2. **State mutations are fragile** — changes are made via nested index access (`projects[pi].worktreeModels[wi].tabs[tabIdx].focusedPaneID = paneID`) with no safety guarantees. Adding a feature requires touching state in multiple places.

3. **AppKit's delegate/target-action pattern is unfamiliar** — the project contributor background is primarily web/React. The mental model mismatch makes even simple UI changes slow and error-prone.

The Ghostty terminal surfaces (`GhosttySurfaceView`) are Metal-backed `NSView` instances driven by a C FFI (`CGhosttyKit`). These cannot be replaced with web technology and must remain AppKit forever.

## Decision

Migrate all shell UI (sidebar, tab bar, empty state, pane layout) to SwiftUI while keeping `GhosttySurfaceView` as-is, bridged into SwiftUI via `NSViewRepresentable`.

Introduce an `AppState: ObservableObject` class as a single reactive store. All UI derives from `@Published` properties on this store — no manual sync calls needed.

## Architecture

### State store (`AppState`)

Replaces all `private var` state in `ManorWindowController`. Analogous to a Redux store.

```swift
@MainActor
final class AppState: ObservableObject {
    @Published var projects: [ProjectModel] = []
    @Published var selectedProjectIndex: Int = 0
    @Published var activePorts: [ActivePort] = []
    @Published var sidebarWidth: CGFloat = 200
    @Published var sidebarVisible: Bool = true
    @Published var paneCWD: [PaneID: String] = [:]

    // NOT @Published — treated like React refs, mutated imperatively
    var paneSurfaces: [PaneID: GhosttySurfaceView] = [:]
}
```

Action methods (`addProject`, `createNewTab`, `splitPane`, etc.) live on `AppState`. Views call these directly instead of going through a delegate.

### Ghostty bridge (`GhosttySurfaceRepresentable`)

```swift
struct GhosttySurfaceRepresentable: NSViewRepresentable {
    let paneID: PaneID
    @EnvironmentObject var appState: AppState

    func makeNSView(context: Context) -> GhosttySurfaceView {
        // Return existing instance — never create a new one for an existing pane
        if let existing = appState.paneSurfaces[paneID] { return existing }
        let view = GhosttySurfaceView(frame: .zero)
        appState.paneSurfaces[paneID] = view
        return view
    }
}
```

**Critical invariant:** `GhosttySurfaceView` must never be destroyed and recreated by SwiftUI's view diffing. Each representable is given `.id(paneID.id)` so SwiftUI treats it as a stable identity across re-renders. Destroying a surface tears down the `ghostty_surface_t` and loses the terminal session.

### Pane layout (`PaneLayoutView`)

The binary-tree layout engine in `PaneContainerView` becomes a recursive SwiftUI view:

```swift
struct PaneLayoutView: View {
    let node: PaneNode
    var body: some View {
        switch node {
        case .leaf(let paneID):
            GhosttySurfaceRepresentable(paneID: paneID).id(paneID.id)
        case .split(let axis, let ratio, let a, let b):
            SplitView(axis: axis, ratio: ratio) {
                PaneLayoutView(node: a)
            } second: {
                PaneLayoutView(node: b)
            }
        }
    }
}
```

### Root view

```swift
struct RootView: View {
    @EnvironmentObject var appState: AppState
    var body: some View {
        HStack(spacing: 0) {
            if appState.sidebarVisible {
                ProjectSidebarView().frame(width: appState.sidebarWidth)
            }
            VStack(spacing: 0) {
                TabBarView().frame(height: 28)
                if let tab = appState.currentTab {
                    PaneLayoutView(node: tab.rootNode)
                } else {
                    EmptyStateView()
                }
            }
        }
    }
}
```

`ManorWindowController` is deleted. `AppDelegate` creates `AppState`, wraps `RootView` in `NSHostingView`, and assigns it as the window's `contentView`.

## Migration Phases

Ordered safest → riskiest. Each phase is independently shippable.

| Phase | What | Notes |
|---|---|---|
| 0 | Extract `AppState` | New file only, no visual change |
| 1 | `EmptyStateView` | Pure SwiftUI, no Ghostty dependency |
| 2 | `TabBarView` | No Ghostty, CVDisplayLink → SwiftUI gestures |
| 3 | `AccordionView` | Replaced by SwiftUI disclosure groups |
| 4 | `ProjectSidebarView` | Theme via `@EnvironmentObject`, inline rename as `TextField` |
| 5 | `GhosttySurfaceRepresentable` | The `NSViewRepresentable` bridge |
| 6 | `PaneLayoutView` | Recursive SwiftUI over `PaneNode` tree |
| 7 | Root assembly + delete `ManorWindowController` | Final wiring |

## Consequences

**Good:**
- SwiftUI's declarative/reactive model matches React mental models — views are functions of state
- Eliminating `ManorWindowController` removes ~1,500 lines of imperative glue code
- `ManorCore` models (already plain value-type structs) require zero changes
- Adding new UI features no longer requires understanding the full coordinator chain

**Bad / Tradeoffs:**
- SwiftUI has rough edges on macOS (focus management, first responder, certain animations) that AppKit handles more predictably
- The `NSViewRepresentable` bridge adds a layer of indirection around Ghostty surface lifecycle
- Some AppKit behaviors (e.g. `NSWindow` title bar customization, traffic light positioning) may need to be re-established after moving to `NSHostingView`
- Migration is a significant investment — the app will be partially AppKit / partially SwiftUI during the transition

## What Does NOT Change

- `GhosttySurfaceView` and all of `Sources/ManorApp/Ghostty/` — untouched
- `ManorCore` models (`ProjectModel`, `WorktreeModel`, `TabModel`, `PaneNode`)
- `ProjectPersistence` — save/load logic is unchanged
- `GitHelper` — all git operations stay as-is
- The Ghostty theme system (`GhosttyTheme`) — exposed through environment but not restructured
