import AppKit
import CGhosttyKit
import ManorCore
import os.log
import SwiftUI

private let logger = Logger(subsystem: "com.manor.app", category: "tabs")

// MARK: - Keybinding Action

enum KeyAction {
    case splitHorizontal
    case splitVertical
    case closePane
    case focusNext
    case focusPrevious
    case focusUp
    case focusDown
    case focusLeft
    case focusRight
    case newTab
    case closeTab
    case nextTab
    case previousTab
    case toggleFullScreen
    case toggleSidebar
    case addProject
    case quit
}

// MARK: - ManorWindow

private final class ManorWindow: NSWindow {
    override func performClose(_ sender: Any?) {
        NSApp.terminate(sender)
    }
}

final class ManorWindowController: NSWindowController {
    // MARK: - App State

    let appState = AppState()
    let themeManager = ThemeManager()

    // MARK: - Init

    init() {
        let window = ManorWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Manor"
        window.minSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false
        // Restore autosaved frame first, then validate it's a reasonable size.
        // setFrameAutosaveName both registers future saves and restores the saved frame.
        window.setFrameAutosaveName("ManorMainWindow")
        let defaultFrame = NSRect(x: 0, y: 0, width: 900, height: 600)
        if !window.setFrameUsingName("ManorMainWindow") || window.frame.width < 600 || window.frame.height < 400 {
            window.setFrame(defaultFrame, display: false)
            window.center()
        }
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = GhosttyApp.shared.theme.terminalBackground

        // Enable full-size content
        window.styleMask.insert(.fullSizeContentView)
        window.isMovable = true
        window.isMovableByWindowBackground = true

        super.init(window: window)

        appState.window = window
        GhosttyApp.shared.delegate = self
        setupRootView()
        setupAppKeybindings()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    // MARK: - View Setup

    private func setupRootView() {
        guard let window else { return }

        let rootView = RootView(appState: appState)
            .environmentObject(themeManager)
        let hostingView = NSHostingView(rootView: rootView)
        // Prevent SwiftUI from reporting a preferred content size (which can shrink the window,
        // especially when GeometryReader views report zero ideal size on macOS 14+).
//        hostingView.sizingOptions = []

        // Use the hosting view directly as the content VC's view so that sheets can be
        // presented via contentViewController, without an intermediate zero-frame NSView
        // that would cause AppKit to resize the window on assignment.
        let contentVC = NSViewController()
        contentVC.view = hostingView
        window.contentViewController = contentVC
    }

    // MARK: - Forwarding (for AppDelegate compatibility)

    var currentProject: ProjectModel? { appState.currentProject }
    func updateCurrentProject(_ project: ProjectModel) { appState.updateCurrentProject(project) }
    func persistProjects() { appState.persistProjects() }
    func persistProjectsNow() { appState.persistProjectsNow() }
    func stopGitHubRefresh() { appState.stopGitHubRefresh() }

    // MARK: - Keybindings

    /// Intercept app-level keybindings (Cmd+D, Cmd+T, etc.) before they reach the surface.
    private func setupAppKeybindings() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, self.window?.isKeyWindow == true else { return event }

            let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])

            if let action = self.appKeyAction(keyCode: event.keyCode, flags: flags) {
                self.handleAppAction(action)
                return nil // consumed
            }

            // Check if ghostty considers this a binding
            if let surface = self.focusedSurface {
                var keyEvent = ghostty_input_key_s()
                keyEvent.action = GHOSTTY_ACTION_PRESS
                keyEvent.keycode = UInt32(event.keyCode)
                keyEvent.mods = self.modsFromFlags(flags)
                keyEvent.consumed_mods = GHOSTTY_MODS_NONE
                keyEvent.composing = false
                keyEvent.text = nil
                if let chars = event.characters(byApplyingModifiers: []),
                   let scalar = chars.unicodeScalars.first {
                    keyEvent.unshifted_codepoint = scalar.value
                } else {
                    keyEvent.unshifted_codepoint = 0
                }

                var bindingFlags: ghostty_binding_flags_e = ghostty_binding_flags_e(rawValue: 0)
                if ghostty_surface_key_is_binding(surface, keyEvent, &bindingFlags) {
                    return event
                }
            }

            return event
        }
    }

    private func appKeyAction(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> KeyAction? {
        switch (keyCode, flags) {
        case (2, .command):                         return .splitHorizontal
        case (2, [.command, .shift]):                return .splitVertical
        case (13, .command):                         return .closePane
        case (13, [.command, .shift]):               return .closeTab
        case (17, .command):                         return .newTab
        case (30, .command):                         return .focusNext
        case (33, .command):                         return .focusPrevious
        case (30, [.command, .shift]):               return .nextTab
        case (33, [.command, .shift]):               return .previousTab
        case (3, [.command, .control]):              return .toggleFullScreen
        case (42, .command):                         return .toggleSidebar    // Cmd+\
        case (31, [.command, .shift]):               return .addProject      // Cmd+Shift+O
        case (12, .command):                         return .quit             // Cmd+Q
        default:                                     return nil
        }
    }

    // MARK: - Action Handler

    private func handleAppAction(_ action: KeyAction) {
        switch action {
        case .splitHorizontal:
            appState.splitPane(direction: .horizontal)
        case .splitVertical:
            appState.splitPane(direction: .vertical)
        case .closePane:
            guard let project = appState.currentProject else { break }
            let tabIdx = project.selectedTabIndex
            guard tabIdx < project.tabs.count else { break }
            appState.removePaneFromTab(project.tabs[tabIdx].focusedPaneID)
        case .focusNext:
            appState.focusNextPane()
        case .focusPrevious:
            appState.focusPreviousPane()
        case .focusUp, .focusDown, .focusLeft, .focusRight:
            appState.focusNextPane()
        case .newTab:
            appState.createNewTab()
        case .closeTab:
            guard appState.selectedProjectIndex < appState.projects.count else { break }
            let tabIdx = appState.currentSelectedTabIndex
            if tabIdx < appState.projects[appState.selectedProjectIndex].tabs.count {
                appState.closeTabAt(tabIdx)
            }
        case .nextTab:
            appState.selectNextTab()
        case .previousTab:
            appState.selectPreviousTab()
        case .toggleFullScreen:
            window?.toggleFullScreen(nil)
        case .toggleSidebar:
            appState.toggleSidebar()
        case .addProject:
            appState.addProject()
        case .quit:
            NSApp.terminate(nil)
        }
    }

    // MARK: - Helpers

    var focusedSurface: ghostty_surface_t? {
        guard let project = appState.currentProject else { return nil }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return nil }
        let focusedID = project.tabs[tabIdx].focusedPaneID
        return appState.paneSurfaces[focusedID]?.surface
    }

    /// Find the PaneID associated with a ghostty surface.
    private func paneID(for surface: ghostty_surface_t) -> PaneID? {
        for (id, view) in appState.paneSurfaces {
            if view.surface == surface {
                return id
            }
        }
        return nil
    }

    private func modsFromFlags(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods: UInt32 = GHOSTTY_MODS_NONE.rawValue
        if flags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { mods |= GHOSTTY_MODS_CAPS.rawValue }

        let rawFlags = flags.rawValue
        if rawFlags & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { mods |= GHOSTTY_MODS_SHIFT_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERCTLKEYMASK) != 0 { mods |= GHOSTTY_MODS_CTRL_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERALTKEYMASK) != 0 { mods |= GHOSTTY_MODS_ALT_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERCMDKEYMASK) != 0 { mods |= GHOSTTY_MODS_SUPER_RIGHT.rawValue }

        return ghostty_input_mods_e(rawValue: mods)
    }

    // MARK: - Menu Actions

    @objc func newTab(_ sender: Any?) {
        appState.createNewTab()
    }

    @objc func splitHorizontal(_ sender: Any?) {
        appState.splitPane(direction: .horizontal)
    }

    @objc func splitVertical(_ sender: Any?) {
        appState.splitPane(direction: .vertical)
    }

    @objc func closePane(_ sender: Any?) {
        guard let project = appState.currentProject else { return }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        appState.removePaneFromTab(project.tabs[tabIdx].focusedPaneID)
    }

    @objc func closeTab(_ sender: Any?) {
        guard appState.selectedProjectIndex < appState.projects.count else { return }
        appState.closeTabAt(appState.currentSelectedTabIndex)
    }

    @objc func selectNextTab(_ sender: Any?) {
        appState.selectNextTab()
    }

    @objc func selectPreviousTab(_ sender: Any?) {
        appState.selectPreviousTab()
    }

    @objc func openProject(_ sender: Any?) {
        appState.addProject()
    }

    @objc func toggleSidebarAction(_ sender: Any?) {
        appState.toggleSidebar()
    }

}

// MARK: - GhosttyAppDelegate

extension ManorWindowController: GhosttyAppDelegate {
    func ghosttyApp(_ app: GhosttyApp, didReceiveAction action: ghostty_action_s, target: ghostty_target_s) -> Bool {
        switch action.tag {
        case GHOSTTY_ACTION_NEW_TAB:
            appState.createNewTab()
            return true

        case GHOSTTY_ACTION_NEW_SPLIT:
            let direction = action.action.new_split
            switch direction {
            case GHOSTTY_SPLIT_DIRECTION_RIGHT, GHOSTTY_SPLIT_DIRECTION_LEFT:
                appState.splitPane(direction: .horizontal)
            case GHOSTTY_SPLIT_DIRECTION_DOWN, GHOSTTY_SPLIT_DIRECTION_UP:
                appState.splitPane(direction: .vertical)
            default:
                appState.splitPane(direction: .horizontal)
            }
            return true

        case GHOSTTY_ACTION_GOTO_SPLIT:
            let goto = action.action.goto_split
            switch goto {
            case GHOSTTY_GOTO_SPLIT_NEXT:
                appState.focusNextPane()
            case GHOSTTY_GOTO_SPLIT_PREVIOUS:
                appState.focusPreviousPane()
            default:
                appState.focusNextPane()
            }
            return true

        case GHOSTTY_ACTION_CLOSE_WINDOW:
            window?.performClose(nil)
            return true

        case GHOSTTY_ACTION_SET_TITLE:
            if let titlePtr = action.action.set_title.title {
                let title = String(cString: titlePtr)
                if target.tag == GHOSTTY_TARGET_SURFACE {
                    guard let surface = target.target.surface else { return false }
                    if let id = paneID(for: surface) {
                        for pi in 0..<appState.projects.count {
                            for wi in 0..<appState.projects[pi].worktreeModels.count {
                                for ti in 0..<appState.projects[pi].worktreeModels[wi].tabs.count {
                                    if appState.projects[pi].worktreeModels[wi].tabs[ti].rootNode.contains(id) {
                                        appState.projects[pi].worktreeModels[wi].tabs[ti].title = title
                                        return true
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return true

        case GHOSTTY_ACTION_SHOW_CHILD_EXITED:
            if target.tag == GHOSTTY_TARGET_SURFACE {
                guard let surface = target.target.surface else { return false }
                if let id = paneID(for: surface) {
                    appState.removePaneFromTab(id)
                }
            }
            return true

        case GHOSTTY_ACTION_OPEN_URL:
            let urlAction = action.action.open_url
            if let urlPtr = urlAction.url,
               let url = URL(string: String(cString: urlPtr)) {
                NSWorkspace.shared.open(url)
            }
            return true

        case GHOSTTY_ACTION_RENDER:
            return true

        case GHOSTTY_ACTION_TOGGLE_FULLSCREEN:
            window?.toggleFullScreen(nil)
            return true

        case GHOSTTY_ACTION_PWD:
            if target.tag == GHOSTTY_TARGET_SURFACE,
               let surface = target.target.surface,
               let id = paneID(for: surface),
               let cwd = action.action.pwd.pwd.map({ String(cString: $0) }) {
                appState.paneCWD[id] = cwd
            }
            return true

        case GHOSTTY_ACTION_COLOR_CHANGE:
            let change = action.action.color_change
            if change.kind == GHOSTTY_ACTION_COLOR_KIND_BACKGROUND {
                let color = NSColor(
                    srgbRed: CGFloat(change.r) / 255.0,
                    green: CGFloat(change.g) / 255.0,
                    blue: CGFloat(change.b) / 255.0,
                    alpha: 1
                )
                window?.backgroundColor = color
                themeManager.reloadFromGhostty()
            }
            return true

        default:
            return false
        }
    }

    func ghosttyApp(_ app: GhosttyApp, closeSurface surface: ghostty_surface_t, needsConfirm: Bool) {
        if let id = paneID(for: surface) {
            appState.removePaneFromTab(id)
        }
    }
}
