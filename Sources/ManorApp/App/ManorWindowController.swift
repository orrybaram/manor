import AppKit
import CGhosttyKit
import os.log

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
}

final class ManorWindowController: NSWindowController {
    private var tabs: [TabModel] = []
    private var selectedTabIndex: Int = 0

    private let tabBarView = TabBarView()
    private let paneContainer = PaneContainerView()
    private var paneSurfaces: [PaneID: GhosttySurfaceView] = [:]

    private let tabBarHeight: CGFloat = 28

    // MARK: - Init

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Manor"
        window.center()
        window.minSize = NSSize(width: 400, height: 300)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(srgbRed: 0.1, green: 0.1, blue: 0.1, alpha: 1)

        // Enable full-size content
        window.styleMask.insert(.fullSizeContentView)

        super.init(window: window)

        GhosttyApp.shared.delegate = self
        setupViews()
        setupAppKeybindings()
        createNewTab()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    // MARK: - View Setup

    private func setupViews() {
        guard let contentView = window?.contentView else { return }

        tabBarView.delegate = self
        tabBarView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(tabBarView)

        paneContainer.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(paneContainer)

        paneContainer.onPaneCreated = { [weak self] paneID, surfaceView in
            self?.paneSurfaces[paneID] = surfaceView
        }

        paneContainer.onFocusChanged = { [weak self] paneID in
            guard let self = self, self.selectedTabIndex < self.tabs.count else { return }
            self.tabs[self.selectedTabIndex].focusedPaneID = paneID
        }

        NSLayoutConstraint.activate([
            tabBarView.topAnchor.constraint(equalTo: contentView.topAnchor),
            tabBarView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            tabBarView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            tabBarView.heightAnchor.constraint(equalToConstant: tabBarHeight),

            paneContainer.topAnchor.constraint(equalTo: tabBarView.bottomAnchor),
            paneContainer.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            paneContainer.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            paneContainer.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])

        // Observe resize
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowDidResize(_:)),
            name: NSWindow.didResizeNotification,
            object: window
        )
    }

    /// Intercept app-level keybindings (Cmd+D, Cmd+T, etc.) before they reach the surface.
    private func setupAppKeybindings() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, self.window?.isKeyWindow == true else { return event }

            let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])

            // Check if ghostty considers this a binding first
            if let surface = self.focusedSurface {
                var keyEvent = ghostty_input_key_s()
                keyEvent.action = GHOSTTY_ACTION_PRESS
                keyEvent.keycode = UInt32(event.keyCode)
                keyEvent.mods = self.modsFromFlags(flags)
                keyEvent.consumed_mods = GHOSTTY_MODS_NONE
                keyEvent.composing = false
                keyEvent.text = nil
                keyEvent.unshifted_codepoint = 0

                var bindingFlags: ghostty_binding_flags_e = ghostty_binding_flags_e(rawValue: 0)
                if ghostty_surface_key_is_binding(surface, keyEvent, &bindingFlags) {
                    // Let ghostty handle it
                    return event
                }
            }

            // Manor app-level keybindings
            if let action = self.appKeyAction(keyCode: event.keyCode, flags: flags) {
                self.handleAppAction(action)
                return nil // consumed
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
        default:                                     return nil
        }
    }

    // MARK: - Tab Management

    private func createNewTab() {
        let paneID = PaneID()
        let tab = TabModel(paneID: paneID, title: "Terminal \(tabs.count + 1)")
        tabs.append(tab)
        selectedTabIndex = tabs.count - 1
        logger.info("Created tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)' (total: \(self.tabs.count))")
        refreshLayout()

        // Create surface in the new pane
        DispatchQueue.main.async { [weak self] in
            self?.startSurfaceForPane(paneID)
        }
    }

    private func startSurfaceForPane(_ paneID: PaneID, config: ghostty_surface_config_s? = nil) {
        guard let surfaceView = paneContainer.surfaceView(for: paneID) ?? paneSurfaces[paneID],
              let app = GhosttyApp.shared.app else { return }

        surfaceView.createSurface(app: app, config: config)
        surfaceView.onClose = { [weak self] in
            self?.removePaneFromCurrentTab(paneID)
        }
        paneContainer.setFocus(paneID)
    }

    // MARK: - Pane Management

    private func splitPane(direction: SplitDirection) {
        guard selectedTabIndex < tabs.count else { return }
        let focusedID = tabs[selectedTabIndex].focusedPaneID
        let newPaneID = PaneID()

        tabs[selectedTabIndex].rootNode = tabs[selectedTabIndex].rootNode.insertSplit(
            at: focusedID,
            direction: direction,
            newID: newPaneID
        )

        refreshLayout()

        // Inherit config from the focused surface
        var config: ghostty_surface_config_s? = nil
        if let focusedSurfaceView = paneSurfaces[focusedID],
           let surface = focusedSurfaceView.surface {
            config = ghostty_surface_inherited_config(surface, GHOSTTY_SURFACE_CONTEXT_SPLIT)
        }

        DispatchQueue.main.async { [weak self] in
            self?.startSurfaceForPane(newPaneID, config: config)
        }
    }

    private func removePaneFromCurrentTab(_ paneID: PaneID) {
        // Find the tab that actually contains this pane (it may not be the selected tab)
        guard let tabIndex = tabs.firstIndex(where: { $0.rootNode.contains(paneID) }) else { return }
        let tab = tabs[tabIndex]
        let allPanes = tab.rootNode.allPaneIDs

        // Remove from paneSurfaces BEFORE destroying so that re-entrant
        // closeSurface callbacks from ghostty can't find this pane again.
        let surfaceView = paneSurfaces.removeValue(forKey: paneID)
        surfaceView?.onClose = nil
        surfaceView?.destroySurface()

        if allPanes.count <= 1 {
            // Last pane in tab
            if tabs.count <= 1 {
                // Last tab — replace with a fresh terminal instead of quitting
                logger.info("Last pane in last tab closed, replacing with fresh tab (tab: \(tab.id, privacy: .public))")
                tabs.remove(at: tabIndex)
                createNewTab()
                return
            }
            logger.info("Last pane closed in tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)', removing tab (remaining: \(self.tabs.count - 1))")
            tabs.remove(at: tabIndex)
            // Adjust selectedTabIndex if the removed tab was at or before it
            if tabIndex <= selectedTabIndex {
                selectedTabIndex = max(0, selectedTabIndex - 1)
            }
            selectedTabIndex = min(selectedTabIndex, tabs.count - 1)
        } else {
            if let newRoot = tabs[tabIndex].rootNode.removing(paneID) {
                tabs[tabIndex].rootNode = newRoot
                let remaining = newRoot.allPaneIDs
                if !remaining.contains(tabs[tabIndex].focusedPaneID) {
                    tabs[tabIndex].focusedPaneID = remaining.first!
                }
            }
        }

        refreshLayout()

        if selectedTabIndex < tabs.count {
            paneContainer.setFocus(tabs[selectedTabIndex].focusedPaneID)
        }
    }

    // MARK: - Focus Navigation

    private func focusNextPane() {
        guard selectedTabIndex < tabs.count else { return }
        let panes = tabs[selectedTabIndex].rootNode.allPaneIDs
        guard panes.count > 1 else { return }
        let currentIdx = panes.firstIndex(of: tabs[selectedTabIndex].focusedPaneID) ?? 0
        let nextIdx = (currentIdx + 1) % panes.count
        tabs[selectedTabIndex].focusedPaneID = panes[nextIdx]
        paneContainer.setFocus(panes[nextIdx])
    }

    private func focusPreviousPane() {
        guard selectedTabIndex < tabs.count else { return }
        let panes = tabs[selectedTabIndex].rootNode.allPaneIDs
        guard panes.count > 1 else { return }
        let currentIdx = panes.firstIndex(of: tabs[selectedTabIndex].focusedPaneID) ?? 0
        let prevIdx = (currentIdx - 1 + panes.count) % panes.count
        tabs[selectedTabIndex].focusedPaneID = panes[prevIdx]
        paneContainer.setFocus(panes[prevIdx])
    }

    // MARK: - Layout

    private func refreshLayout() {
        guard selectedTabIndex < tabs.count else { return }

        let tabData = tabs.map { (id: $0.id, title: $0.title) }
        tabBarView.update(tabs: tabData, selectedIndex: selectedTabIndex)

        let rect = paneContainer.bounds
        guard rect.width > 0, rect.height > 0 else {
            DispatchQueue.main.async { [weak self] in
                self?.refreshLayout()
            }
            return
        }
        paneContainer.layout(node: tabs[selectedTabIndex].rootNode, in: rect)
    }

    @objc private func windowDidResize(_ notification: Notification) {
        refreshLayout()
    }

    // MARK: - Action Handler

    private func handleAppAction(_ action: KeyAction) {
        switch action {
        case .splitHorizontal:
            splitPane(direction: .horizontal)
        case .splitVertical:
            splitPane(direction: .vertical)
        case .closePane:
            guard selectedTabIndex < tabs.count else { break }
            removePaneFromCurrentTab(tabs[selectedTabIndex].focusedPaneID)
        case .focusNext:
            focusNextPane()
        case .focusPrevious:
            focusPreviousPane()
        case .focusUp, .focusDown, .focusLeft, .focusRight:
            focusNextPane()
        case .newTab:
            createNewTab()
        case .closeTab:
            if selectedTabIndex < tabs.count {
                closeTabAt(selectedTabIndex)
            }
        case .nextTab:
            if tabs.count > 1 {
                selectedTabIndex = (selectedTabIndex + 1) % tabs.count
                refreshLayout()
                paneContainer.setFocus(tabs[selectedTabIndex].focusedPaneID)
            }
        case .previousTab:
            if tabs.count > 1 {
                selectedTabIndex = (selectedTabIndex - 1 + tabs.count) % tabs.count
                refreshLayout()
                paneContainer.setFocus(tabs[selectedTabIndex].focusedPaneID)
            }
        case .toggleFullScreen:
            window?.toggleFullScreen(nil)
        }
    }

    private func closeTabAt(_ index: Int) {
        guard index < tabs.count else { return }
        let tab = tabs[index]
        let panes = tab.rootNode.allPaneIDs
        logger.info("Closing tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)' at index \(index) (panes: \(panes.count), total tabs: \(self.tabs.count))")
        for paneID in panes {
            // Remove from paneSurfaces BEFORE destroying so that re-entrant
            // closeSurface callbacks from ghostty can't find this pane again.
            let surfaceView = paneSurfaces.removeValue(forKey: paneID)
            surfaceView?.onClose = nil
            surfaceView?.destroySurface()
        }

        tabs.remove(at: index)
        if tabs.isEmpty {
            logger.info("Last tab closed, closing window")
            window?.close()
            return
        }
        // Adjust selectedTabIndex properly when closing a tab before or at the selection
        if index <= selectedTabIndex {
            selectedTabIndex = max(0, selectedTabIndex - 1)
        }
        selectedTabIndex = min(selectedTabIndex, tabs.count - 1)
        refreshLayout()
        paneContainer.setFocus(tabs[selectedTabIndex].focusedPaneID)
    }

    // MARK: - Helpers

    private var focusedSurface: ghostty_surface_t? {
        guard selectedTabIndex < tabs.count else { return nil }
        let focusedID = tabs[selectedTabIndex].focusedPaneID
        return paneSurfaces[focusedID]?.surface
    }

    /// Find the PaneID associated with a ghostty surface.
    private func paneID(for surface: ghostty_surface_t) -> PaneID? {
        for (id, view) in paneSurfaces {
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
        return ghostty_input_mods_e(rawValue: mods)
    }

    // MARK: - Menu Actions

    @objc func newTab(_ sender: Any?) {
        createNewTab()
    }

    @objc func splitHorizontal(_ sender: Any?) {
        splitPane(direction: .horizontal)
    }

    @objc func splitVertical(_ sender: Any?) {
        splitPane(direction: .vertical)
    }

    @objc func closePane(_ sender: Any?) {
        guard selectedTabIndex < tabs.count else { return }
        removePaneFromCurrentTab(tabs[selectedTabIndex].focusedPaneID)
    }

    @objc func closeTab(_ sender: Any?) {
        guard selectedTabIndex < tabs.count else { return }
        closeTabAt(selectedTabIndex)
    }

    @objc func selectNextTab(_ sender: Any?) {
        handleAppAction(.nextTab)
    }

    @objc func selectPreviousTab(_ sender: Any?) {
        handleAppAction(.previousTab)
    }
}

// MARK: - TabBarDelegate

extension ManorWindowController: TabBarDelegate {
    func tabBar(_ tabBar: TabBarView, didSelectTabAt index: Int) {
        guard index < tabs.count else { return }
        selectedTabIndex = index
        refreshLayout()
        paneContainer.setFocus(tabs[selectedTabIndex].focusedPaneID)
    }

    func tabBar(_ tabBar: TabBarView, didCloseTabAt index: Int) {
        closeTabAt(index)
    }

    func tabBarDidRequestNewTab(_ tabBar: TabBarView) {
        createNewTab()
    }
}

// MARK: - GhosttyAppDelegate

extension ManorWindowController: GhosttyAppDelegate {
    func ghosttyApp(_ app: GhosttyApp, didReceiveAction action: ghostty_action_s, target: ghostty_target_s) -> Bool {
        switch action.tag {
        case GHOSTTY_ACTION_NEW_TAB:
            createNewTab()
            return true

        case GHOSTTY_ACTION_NEW_SPLIT:
            let direction = action.action.new_split
            switch direction {
            case GHOSTTY_SPLIT_DIRECTION_RIGHT, GHOSTTY_SPLIT_DIRECTION_LEFT:
                splitPane(direction: .horizontal)
            case GHOSTTY_SPLIT_DIRECTION_DOWN, GHOSTTY_SPLIT_DIRECTION_UP:
                splitPane(direction: .vertical)
            default:
                splitPane(direction: .horizontal)
            }
            return true

        case GHOSTTY_ACTION_GOTO_SPLIT:
            let goto = action.action.goto_split
            switch goto {
            case GHOSTTY_GOTO_SPLIT_NEXT:
                focusNextPane()
            case GHOSTTY_GOTO_SPLIT_PREVIOUS:
                focusPreviousPane()
            default:
                focusNextPane()
            }
            return true

        case GHOSTTY_ACTION_CLOSE_WINDOW:
            window?.close()
            return true

        case GHOSTTY_ACTION_SET_TITLE:
            if let titlePtr = action.action.set_title.title {
                let title = String(cString: titlePtr)
                // Update the tab title for the surface that sent this
                if target.tag == GHOSTTY_TARGET_SURFACE {
                    guard let surface = target.target.surface else { return false }
                    if let id = paneID(for: surface) {
                        for i in 0..<tabs.count {
                            if tabs[i].rootNode.contains(id) {
                                tabs[i].title = title
                                let tabData = tabs.map { (id: $0.id, title: $0.title) }
                                tabBarView.update(tabs: tabData, selectedIndex: selectedTabIndex)
                                break
                            }
                        }
                    }
                }
            }
            return true

        case GHOSTTY_ACTION_SHOW_CHILD_EXITED:
            // Process exited — close the pane
            if target.tag == GHOSTTY_TARGET_SURFACE {
                guard let surface = target.target.surface else { return false }
                if let id = paneID(for: surface) {
                    removePaneFromCurrentTab(id)
                }
            }
            return true

        case GHOSTTY_ACTION_RENDER:
            // GhosttyKit wants us to trigger a render — it handles this internally
            return true

        case GHOSTTY_ACTION_TOGGLE_FULLSCREEN:
            window?.toggleFullScreen(nil)
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
            }
            return true

        default:
            return false
        }
    }

    func ghosttyApp(_ app: GhosttyApp, closeSurface surface: ghostty_surface_t, needsConfirm: Bool) {
        if let id = paneID(for: surface) {
            removePaneFromCurrentTab(id)
        }
    }
}
