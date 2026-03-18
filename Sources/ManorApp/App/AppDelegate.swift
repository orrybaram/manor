import AppKit
import ManorCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windowController: ManorWindowController?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenuBar()

        // Initialize GhosttyKit before creating any windows/surfaces
        let ghostty = GhosttyApp.shared
        guard ghostty.app != nil else {
            NSLog("Manor: Failed to initialize GhosttyKit, falling back not implemented")
            NSApp.terminate(nil)
            return
        }

        let controller = ManorWindowController()
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        self.windowController = controller

        // Load projects after the window is visible so git subprocesses
        // don't block the main thread before the run loop starts.
        DispatchQueue.main.async {
            controller.appState.loadProjects()
            controller.appState.startPortScanner()
            controller.appState.startGitHubRefresh()
        }

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows {
            windowController?.showWindow(nil)
            windowController?.window?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let alert = NSAlert()
        alert.messageText = "Quit Manor?"
        alert.informativeText = "All terminal sessions will be closed."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        return response == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        windowController?.stopGitHubRefresh()
        windowController?.persistProjectsNow()
    }

    @MainActor @objc func openProjectSettings(_ sender: Any?) {
        guard let wc = windowController,
              let window = wc.window,
              let project = wc.currentProject else { return }
        let vc = ProjectSettingsViewController(project: project) { [weak wc] updated in
            wc?.updateCurrentProject(updated)
        }
        window.contentViewController?.presentAsSheet(vc)
    }

    // MARK: - Menu Bar

    @MainActor private func setupMenuBar() {
        let mainMenu = NSMenu()

        // App menu
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Manor", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Manor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Shell menu
        let shellMenu = NSMenu(title: "Shell")
        shellMenu.addItem(withTitle: "New Tab", action: #selector(ManorWindowController.newTab(_:)), keyEquivalent: "t")
        shellMenu.addItem(withTitle: "Split Horizontally", action: #selector(ManorWindowController.splitHorizontal(_:)), keyEquivalent: "d")

        let splitVertItem = NSMenuItem(title: "Split Vertically", action: #selector(ManorWindowController.splitVertical(_:)), keyEquivalent: "d")
        splitVertItem.keyEquivalentModifierMask = [.command, .shift]
        shellMenu.addItem(splitVertItem)

        shellMenu.addItem(.separator())
        shellMenu.addItem(withTitle: "Close Pane", action: #selector(ManorWindowController.closePane(_:)), keyEquivalent: "w")

        let closeTabItem = NSMenuItem(title: "Close Tab", action: #selector(ManorWindowController.closeTab(_:)), keyEquivalent: "w")
        closeTabItem.keyEquivalentModifierMask = [.command, .shift]
        shellMenu.addItem(closeTabItem)

        let shellMenuItem = NSMenuItem()
        shellMenuItem.submenu = shellMenu
        mainMenu.addItem(shellMenuItem)

        // Project menu
        let projectMenu = NSMenu(title: "Project")

        let openProjectItem = NSMenuItem(title: "Open Project...", action: #selector(ManorWindowController.openProject(_:)), keyEquivalent: "o")
        openProjectItem.keyEquivalentModifierMask = [.command, .shift]
        projectMenu.addItem(openProjectItem)

        let toggleSidebarItem = NSMenuItem(title: "Toggle Sidebar", action: #selector(ManorWindowController.toggleSidebarAction(_:)), keyEquivalent: "\\")
        toggleSidebarItem.keyEquivalentModifierMask = [.command]
        projectMenu.addItem(toggleSidebarItem)

        projectMenu.addItem(withTitle: "Project Settings…", action: #selector(openProjectSettings(_:)), keyEquivalent: ",")

        let projectMenuItem = NSMenuItem()
        projectMenuItem.submenu = projectMenu
        mainMenu.addItem(projectMenuItem)

        // Edit menu (for paste)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // Window menu
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        let nextTabItem = NSMenuItem(title: "Next Tab", action: #selector(ManorWindowController.selectNextTab(_:)), keyEquivalent: "]")
        nextTabItem.keyEquivalentModifierMask = [.command, .shift]
        windowMenu.addItem(nextTabItem)

        let prevTabItem = NSMenuItem(title: "Previous Tab", action: #selector(ManorWindowController.selectPreviousTab(_:)), keyEquivalent: "[")
        prevTabItem.keyEquivalentModifierMask = [.command, .shift]
        windowMenu.addItem(prevTabItem)

        let windowMenuItem = NSMenuItem()
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }
}
