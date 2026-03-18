import AppKit
import CGhosttyKit
import ManorCore
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
    case toggleSidebar
    case addProject
}

final class ManorWindowController: NSWindowController {
    // MARK: - Project State (replaces tabs/selectedTabIndex)

    private var projects: [ProjectModel] = []
    private var selectedProjectIndex: Int = 0

    // Convenience accessors
    private var currentProject: ProjectModel? {
        guard selectedProjectIndex < projects.count else { return nil }
        return projects[selectedProjectIndex]
    }
    private var currentTabs: [TabModel] {
        currentProject?.tabs ?? []
    }
    private var currentSelectedTabIndex: Int {
        get { currentProject?.selectedTabIndex ?? 0 }
        set {
            guard selectedProjectIndex < projects.count else { return }
            projects[selectedProjectIndex].selectedTabIndex = newValue
        }
    }

    // MARK: - Views

    private let sidebarView = ProjectSidebarView()
    private let tabBarView = TabBarView()
    private let paneContainer = PaneContainerView()
    private let emptyStateView = EmptyStateView()
    private var paneSurfaces: [PaneID: GhosttySurfaceView] = [:]
    private var paneCWD: [PaneID: String] = [:]
    private let portScanner = ActivePortScanner()
    private var githubRefreshTimer: DispatchSourceTimer?
    private let tabBarHeight: CGFloat = 28
    private var sidebarWidthConstraint: NSLayoutConstraint!
    private var sidebarVisible = true

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
        window.backgroundColor = GhosttyApp.shared.theme.terminalBackground

        // Enable full-size content
        window.styleMask.insert(.fullSizeContentView)
        window.isMovable = false

        super.init(window: window)

        GhosttyApp.shared.delegate = self
        setupViews()
        setupAppKeybindings()
        loadProjects()
        startPortScanner()
        startGitHubRefresh()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    // MARK: - View Setup

    private func setupViews() {
        guard let contentView = window?.contentView else { return }

        // Sidebar
        sidebarView.delegate = self
        sidebarView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(sidebarView)

        let savedWidth = UserDefaults.standard.double(forKey: ProjectSidebarView.widthKey)
        let sidebarWidth = savedWidth > 0 ? CGFloat(savedWidth) : ProjectSidebarView.defaultWidth
        sidebarWidthConstraint = sidebarView.widthAnchor.constraint(equalToConstant: sidebarWidth)
        sidebarView.widthConstraintRef = sidebarWidthConstraint

        sidebarView.onWidthChanged = { [weak self] newWidth in
            self?.sidebarWidthConstraint.constant = newWidth
        }

        // Tab bar
        tabBarView.delegate = self
        tabBarView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(tabBarView)

        // Pane container
        paneContainer.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(paneContainer)

        paneContainer.onPaneCreated = { [weak self] paneID, surfaceView in
            self?.paneSurfaces[paneID] = surfaceView
        }

        paneContainer.onFocusChanged = { [weak self] paneID in
            guard let self = self,
                  self.selectedProjectIndex < self.projects.count else { return }
            let pi = self.selectedProjectIndex
            let wi = self.projects[pi].selectedWorktreeIndex
            let tabIdx = self.projects[pi].worktreeModels[wi].selectedTabIndex
            guard tabIdx < self.projects[pi].worktreeModels[wi].tabs.count else { return }
            self.projects[pi].worktreeModels[wi].tabs[tabIdx].focusedPaneID = paneID
        }

        paneContainer.onRatioChanged = { [weak self] path, newRatio in
            guard let self = self,
                  self.selectedProjectIndex < self.projects.count else { return }
            let pi = self.selectedProjectIndex
            let wi = self.projects[pi].selectedWorktreeIndex
            let tabIdx = self.projects[pi].worktreeModels[wi].selectedTabIndex
            guard tabIdx < self.projects[pi].worktreeModels[wi].tabs.count else { return }
            self.projects[pi].worktreeModels[wi].tabs[tabIdx].rootNode =
                self.projects[pi].worktreeModels[wi].tabs[tabIdx].rootNode.withUpdatedRatio(at: path, newRatio: newRatio)
            self.refreshLayout()
        }

        // Empty state — overlays same area as pane container
        emptyStateView.translatesAutoresizingMaskIntoConstraints = false
        emptyStateView.isHidden = true
        emptyStateView.onNewTerminal = { [weak self] in
            self?.createNewTab()
        }
        emptyStateView.onAddProject = { [weak self] in
            self?.addProject()
        }
        contentView.addSubview(emptyStateView)

        NSLayoutConstraint.activate([
            // Sidebar
            sidebarView.topAnchor.constraint(equalTo: contentView.topAnchor),
            sidebarView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            sidebarView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            sidebarWidthConstraint,

            // Tab bar — to the right of sidebar
            tabBarView.topAnchor.constraint(equalTo: contentView.topAnchor),
            tabBarView.leadingAnchor.constraint(equalTo: sidebarView.trailingAnchor),
            tabBarView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            tabBarView.heightAnchor.constraint(equalToConstant: tabBarHeight),

            // Pane container — to the right of sidebar, below tab bar
            paneContainer.topAnchor.constraint(equalTo: tabBarView.bottomAnchor),
            paneContainer.leadingAnchor.constraint(equalTo: sidebarView.trailingAnchor),
            paneContainer.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            paneContainer.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),

            // Empty state — same frame as pane container
            emptyStateView.topAnchor.constraint(equalTo: tabBarView.bottomAnchor),
            emptyStateView.leadingAnchor.constraint(equalTo: sidebarView.trailingAnchor),
            emptyStateView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            emptyStateView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
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

            // Manor app-level keybindings are checked first so that shortcuts like
            // cmd+shift+[ / cmd+shift+] always switch tabs even if Ghostty has
            // bound those same keys internally.
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
                // Use the unshifted codepoint so ghostty can match unicode-based bindings
                // (e.g. cmd+= bound to increase_font_size uses .unicode = '=' not physical key)
                if let chars = event.characters(byApplyingModifiers: []),
                   let scalar = chars.unicodeScalars.first {
                    keyEvent.unshifted_codepoint = scalar.value
                } else {
                    keyEvent.unshifted_codepoint = 0
                }

                var bindingFlags: ghostty_binding_flags_e = ghostty_binding_flags_e(rawValue: 0)
                if ghostty_surface_key_is_binding(surface, keyEvent, &bindingFlags) {
                    // Let ghostty handle it
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
        default:                                     return nil
        }
    }

    // MARK: - Project Management

    private func loadProjects() {
        let (restored, restoredCWD) = ProjectPersistence.restore()
        projects = restored
        paneCWD = restoredCWD
        selectedProjectIndex = 0
        refreshSidebar()
        refreshLayout()
    }

    func addProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a git repository to add as a project"

        panel.begin { [weak self] response in
            guard let self = self, response == .OK, let url = panel.url else { return }
            if let existing = self.projects.firstIndex(where: { $0.path == url }) {
                self.selectedProjectIndex = existing
                self.refreshSidebar()
                self.refreshLayout()
                return
            }

            guard GitHelper.isGitRepo(at: url) else {
                let alert = NSAlert()
                alert.messageText = "Not a Git Repository"
                alert.informativeText = "The selected directory is not a git repository."
                alert.runModal()
                return
            }

            let name = GitHelper.repoName(at: url)
            let gitWorktrees = GitHelper.listWorktrees(at: url)
            let detectedDefault = GitHelper.defaultBranch(at: url)

            let worktreeModels: [WorktreeModel]
            if gitWorktrees.isEmpty {
                let defaultInfo = WorktreeInfo(path: url.path, branch: name, isMain: true)
                worktreeModels = [WorktreeModel(info: defaultInfo)]
            } else {
                worktreeModels = gitWorktrees.map { WorktreeModel(info: $0) }
            }

            let project = ProjectModel(
                name: name,
                path: url,
                worktreeModels: worktreeModels,
                defaultBranch: detectedDefault
            )

            self.projects.append(project)
            self.selectedProjectIndex = self.projects.count - 1
            self.refreshSidebar()
            self.refreshLayout()
            self.persistProjects()
            self.refreshGitHubData()
        }
    }

    func removeProject(at index: Int) {
        guard index < projects.count else { return }
        let project = projects[index]

        // Destroy all surfaces for this project (across all worktrees)
        for wt in project.worktreeModels {
            for tab in wt.tabs {
                for paneID in tab.rootNode.allPaneIDs {
                    let surfaceView = paneSurfaces.removeValue(forKey: paneID)
                    surfaceView?.onClose = nil
                    surfaceView?.destroySurface()
                    paneContainer.destroyPaneView(for: paneID)
                }
            }
        }

        projects.remove(at: index)

        if index <= selectedProjectIndex {
            selectedProjectIndex = max(0, selectedProjectIndex - 1)
        }
        if !projects.isEmpty {
            selectedProjectIndex = min(selectedProjectIndex, projects.count - 1)
        }

        refreshSidebar()
        refreshLayout()
        persistProjects()

        if let project = currentProject, currentSelectedTabIndex < project.tabs.count {
            paneContainer.setFocus(project.tabs[currentSelectedTabIndex].focusedPaneID)
        }
    }

    private func selectProject(at index: Int) {
        guard index < projects.count, index != selectedProjectIndex else { return }
        selectedProjectIndex = index
        refreshWorktrees()

        // Delegate to selectWorktree to ensure surfaces are started
        let wtIdx = projects[selectedProjectIndex].selectedWorktreeIndex
        selectWorktree(at: wtIdx, inProject: selectedProjectIndex)
    }

    private func selectWorktree(at worktreeIndex: Int, inProject projectIndex: Int) {
        guard projectIndex < projects.count,
              worktreeIndex < projects[projectIndex].worktreeModels.count else { return }

        if projectIndex != selectedProjectIndex {
            selectedProjectIndex = projectIndex
        }
        projects[selectedProjectIndex].selectedWorktreeIndex = worktreeIndex

        let wt = projects[selectedProjectIndex].worktreeModels[worktreeIndex]

        refreshSidebar()
        refreshLayout()

        // Focus the selected tab's focused pane (refreshLayout starts missing surfaces)
        if !wt.tabs.isEmpty {
            let tabIdx = wt.selectedTabIndex
            if tabIdx < wt.tabs.count {
                paneContainer.setFocus(wt.tabs[tabIdx].focusedPaneID)
            }
        }
    }

    private func refreshWorktrees() {
        refreshWorktrees(for: selectedProjectIndex)
    }

    private func refreshWorktrees(for projectIndex: Int) {
        guard projectIndex < projects.count else { return }
        let url = projects[projectIndex].path
        let gitWorktrees = GitHelper.listWorktrees(at: url)

        // Sync worktree models: keep existing ones (with their tabs), add new, remove deleted
        var existingByPath: [String: WorktreeModel] = [:]
        for wt in projects[projectIndex].worktreeModels {
            existingByPath[wt.info.path] = wt
        }

        var newModels: [WorktreeModel] = []
        for gitWt in gitWorktrees {
            if var existing = existingByPath[gitWt.path] {
                existing.info = gitWt
                newModels.append(existing)
            } else {
                newModels.append(WorktreeModel(info: gitWt))
            }
        }

        if newModels.isEmpty {
            let defaultInfo = WorktreeInfo(path: url.path, branch: projects[projectIndex].name, isMain: true)
            newModels = [WorktreeModel(info: defaultInfo)]
        }

        projects[projectIndex].worktreeModels = newModels
        if projects[projectIndex].selectedWorktreeIndex >= newModels.count {
            projects[projectIndex].selectedWorktreeIndex = 0
        }

        if projectIndex == selectedProjectIndex {
            refreshSidebar()
            refreshLayout()
        } else {
            refreshSidebar()
        }
    }

    /// Destroys all terminal sessions associated with a worktree path.
    private func destroyWorktreeSessions(path: String, projectIndex: Int) {
        guard projectIndex < projects.count else { return }
        guard let wtIdx = projects[projectIndex].worktreeModels.firstIndex(where: { $0.info.path == path }) else { return }
        let wt = projects[projectIndex].worktreeModels[wtIdx]

        for tab in wt.tabs {
            for paneID in tab.rootNode.allPaneIDs {
                let surfaceView = paneSurfaces.removeValue(forKey: paneID)
                surfaceView?.onClose = nil
                surfaceView?.destroySurface()
                paneContainer.destroyPaneView(for: paneID)
            }
        }

        projects[projectIndex].worktreeModels[wtIdx].tabs = []
        projects[projectIndex].worktreeModels[wtIdx].selectedTabIndex = 0

        if projectIndex == selectedProjectIndex &&
            projects[projectIndex].selectedWorktreeIndex == wtIdx {
            refreshLayout()
        }
    }

    private func refreshSidebar() {
        sidebarView.projects = projects.map { project in
            let selectedWtPath: String? = project.worktreeModels.isEmpty
                ? nil
                : project.worktreeModels[project.selectedWorktreeIndex].info.path

            // Map worktree models to view items
            var items = project.worktreeModels.map { wt in
                WorktreeViewItem(
                    info: wt.info,
                    label: wt.label,
                    hasRunCommand: wt.runCommand != nil || project.defaultRunCommand != nil,
                    prInfo: wt.prInfo,
                    diffStat: wt.diffStat
                )
            }

            // Ensure default branch is always visible (even if no worktree is checked out for it)
            let hasDefault = items.contains { $0.info.branch == project.defaultBranch && $0.info.isCheckedOut }
            if !hasDefault {
                let phantom = WorktreeInfo(
                    path: "",
                    branch: project.defaultBranch,
                    isMain: true,
                    isCheckedOut: false
                )
                items.insert(WorktreeViewItem(info: phantom, label: project.defaultBranch, hasRunCommand: false), at: 0)
            }

            return (id: project.id, name: project.name, worktrees: items, selectedWorktreePath: selectedWtPath)
        }
        sidebarView.selectedProjectIndex = selectedProjectIndex
        updatePortScannerWorktreePaths()
    }

    private func toggleSidebar() {
        sidebarVisible.toggle()
        if sidebarVisible {
            let saved = CGFloat(UserDefaults.standard.double(forKey: ProjectSidebarView.widthKey))
            sidebarWidthConstraint.constant = saved > 0 ? saved : ProjectSidebarView.defaultWidth
        } else {
            sidebarWidthConstraint.constant = 0
        }
        sidebarView.isHidden = !sidebarVisible
        refreshLayout()
    }

    func persistProjects() {
        ProjectPersistence.persist(projects: projects, selectedIndex: selectedProjectIndex, paneCWD: paneCWD)
    }

    func stopGitHubRefresh() {
        githubRefreshTimer?.cancel()
        githubRefreshTimer = nil
    }

    // MARK: - Port Scanner

    private func startPortScanner() {
        portScanner.onPortsChanged = { [weak self] ports in
            self?.sidebarView.activePorts = ports
        }
        portScanner.start()
    }

    // MARK: - GitHub Refresh

    private func startGitHubRefresh() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: 60)
        timer.setEventHandler { [weak self] in
            self?.refreshGitHubData()
        }
        timer.resume()
        githubRefreshTimer = timer
    }

    private func refreshGitHubData() {
        // Snapshot projects on main thread, then fetch on background
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let snapshot = self.projects.enumerated().map { (pi, project) in
                (pi: pi, defaultBranch: project.defaultBranch, worktrees: project.worktreeModels.enumerated().map { (wi, wt) in
                    (wi: wi, path: wt.info.path, isMain: wt.info.isMain)
                })
            }
            DispatchQueue.global(qos: .utility).async {
                var updates: [(pi: Int, wi: Int, prInfo: GitHubPRInfo?, diffStat: DiffStat?)] = []
                for proj in snapshot {
                    for wt in proj.worktrees {
                        guard !wt.path.isEmpty else { continue }
                        let pr: GitHubPRInfo? = wt.isMain ? nil : GitHubHelper.prInfo(at: wt.path)
                        let diff: DiffStat? = wt.isMain ? nil : GitHubHelper.diffStat(at: wt.path, against: proj.defaultBranch)
                        if pr != nil || diff != nil {
                            updates.append((pi: proj.pi, wi: wt.wi, prInfo: pr, diffStat: diff))
                        } else {
                            updates.append((pi: proj.pi, wi: wt.wi, prInfo: nil, diffStat: nil))
                        }
                    }
                }
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    var changed = false
                    for u in updates {
                        guard u.pi < self.projects.count,
                              u.wi < self.projects[u.pi].worktreeModels.count else { continue }
                        self.projects[u.pi].worktreeModels[u.wi].prInfo = u.prInfo
                        self.projects[u.pi].worktreeModels[u.wi].diffStat = u.diffStat
                        changed = true
                    }
                    if changed { self.refreshSidebar() }
                }
            }
        }
    }

    private func updatePortScannerWorktreePaths() {
        portScanner.updateWorktreePaths(projects.flatMap { $0.worktreeModels.map { $0.info.path } })
    }

    // MARK: - Tab Management

    private func createNewTab(runningScript: String? = nil) {
        guard selectedProjectIndex < projects.count else { return }
        let paneID = PaneID()
        let tabCount = projects[selectedProjectIndex].tabs.count
        let tab = TabModel(paneID: paneID, title: "Terminal \(tabCount + 1)")
        projects[selectedProjectIndex].tabs.append(tab)
        projects[selectedProjectIndex].selectedTabIndex = projects[selectedProjectIndex].tabs.count - 1
        logger.info("Created tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)' (total: \(tabCount + 1))")
        refreshLayout()
        persistProjects()

        let wtIdx = projects[selectedProjectIndex].selectedWorktreeIndex
        let workDir = URL(fileURLWithPath: projects[selectedProjectIndex].worktreeModels[wtIdx].info.path)
        DispatchQueue.main.async { [weak self] in
            self?.startSurfaceForPane(paneID, workingDirectory: workDir, initialInput: runningScript)
        }
    }

    /// Start surfaces for any panes in the given tab that don't have a running surface yet.
    private func startMissingSurfaces(for tab: TabModel) {
        guard selectedProjectIndex < projects.count else { return }
        let wtIdx = projects[selectedProjectIndex].selectedWorktreeIndex
        let wtPath = projects[selectedProjectIndex].worktreeModels[wtIdx].info.path
        for paneID in tab.rootNode.allPaneIDs {
            if paneSurfaces[paneID]?.surface == nil {
                let cwd = paneCWD[paneID] ?? wtPath
                let workDir = URL(fileURLWithPath: cwd)
                DispatchQueue.main.async { [weak self] in
                    self?.startSurfaceForPane(paneID, workingDirectory: workDir)
                }
            }
        }
    }

    private func withEnvVarsC(
        _ vars: [(key: String, value: String)],
        body: (UnsafeMutablePointer<ghostty_env_var_s>, Int) -> Void
    ) {
        func recurse(_ idx: Int, _ keys: [UnsafePointer<Int8>], _ vals: [UnsafePointer<Int8>]) {
            if idx == vars.count {
                var envVars = zip(keys, vals).map { ghostty_env_var_s(key: $0, value: $1) }
                envVars.withUnsafeMutableBufferPointer { buf in
                    body(buf.baseAddress!, vars.count)
                }
                return
            }
            vars[idx].key.withCString { kPtr in
                vars[idx].value.withCString { vPtr in
                    recurse(idx + 1, keys + [kPtr], vals + [vPtr])
                }
            }
        }
        recurse(0, [], [])
    }

    private func startSurfaceForPane(
        _ paneID: PaneID,
        config: ghostty_surface_config_s? = nil,
        workingDirectory: URL? = nil,
        initialInput: String? = nil
    ) {
        guard let surfaceView = paneContainer.surfaceView(for: paneID) ?? paneSurfaces[paneID],
              let app = GhosttyApp.shared.app else { return }

        var surfaceConfig = config ?? ghostty_surface_config_s()

        let histFile = ProjectPersistence.historyFile(for: paneID)
        try? FileManager.default.createDirectory(
            at: ProjectPersistence.sessionsDirectory,
            withIntermediateDirectories: true
        )
        let envVarPairs: [(key: String, value: String)] = [
            ("HISTFILE", histFile.path),
            ("HISTSIZE", "10000"),
            ("SAVEHIST", "10000"),
            ("HISTFILESIZE", "10000"),
        ]

        withEnvVarsC(envVarPairs) { envPtr, envCount in
            surfaceConfig.env_vars = envPtr
            surfaceConfig.env_var_count = envCount

            func doCreate() {
                surfaceView.createSurface(app: app, config: surfaceConfig)
                surfaceView.onClose = { [weak self] in self?.removePaneFromTab(paneID) }
                paneContainer.setFocus(paneID)
            }

            switch (workingDirectory, initialInput) {
            case (.some(let workDir), .some(let input)):
                workDir.path.withCString { wdCStr in
                    (input + "\n").withCString { inputCStr in
                        surfaceConfig.working_directory = wdCStr
                        surfaceConfig.initial_input = inputCStr
                        doCreate()
                    }
                }
            case (.some(let workDir), .none):
                workDir.path.withCString { wdCStr in
                    surfaceConfig.working_directory = wdCStr
                    doCreate()
                }
            case (.none, .some(let input)):
                (input + "\n").withCString { inputCStr in
                    surfaceConfig.initial_input = inputCStr
                    doCreate()
                }
            case (.none, .none):
                doCreate()
            }
        }
    }

    // MARK: - Pane Management

    private func splitPane(direction: SplitDirection) {
        guard selectedProjectIndex < projects.count else { return }
        let tabIdx = currentSelectedTabIndex
        guard tabIdx < projects[selectedProjectIndex].tabs.count else { return }
        let focusedID = projects[selectedProjectIndex].tabs[tabIdx].focusedPaneID
        let newPaneID = PaneID()

        projects[selectedProjectIndex].tabs[tabIdx].rootNode =
            projects[selectedProjectIndex].tabs[tabIdx].rootNode.insertSplit(
                at: focusedID,
                direction: direction,
                newID: newPaneID
            )

        refreshLayout()
        persistProjects()

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

    private func removePaneFromTab(_ paneID: PaneID) {
        // Search across ALL projects and worktrees for the tab containing this pane
        var foundProjectIdx: Int?
        var foundWorktreeIdx: Int?
        var foundTabIdx: Int?

        outer: for pi in 0..<projects.count {
            for wi in 0..<projects[pi].worktreeModels.count {
                for ti in 0..<projects[pi].worktreeModels[wi].tabs.count {
                    if projects[pi].worktreeModels[wi].tabs[ti].rootNode.contains(paneID) {
                        foundProjectIdx = pi
                        foundWorktreeIdx = wi
                        foundTabIdx = ti
                        break outer
                    }
                }
            }
        }

        guard let projectIdx = foundProjectIdx,
              let worktreeIdx = foundWorktreeIdx,
              let tabIdx = foundTabIdx else { return }
        let tab = projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx]
        let allPanes = tab.rootNode.allPaneIDs

        // Remove from paneSurfaces BEFORE destroying so that re-entrant
        // closeSurface callbacks from ghostty can't find this pane again.
        let surfaceView = paneSurfaces.removeValue(forKey: paneID)
        surfaceView?.onClose = nil
        surfaceView?.destroySurface()
        paneContainer.destroyPaneView(for: paneID)

        let isActiveWorktree = projectIdx == selectedProjectIndex &&
            worktreeIdx == projects[projectIdx].selectedWorktreeIndex

        if allPanes.count <= 1 {
            // Last pane in tab
            if projects[projectIdx].worktreeModels[worktreeIdx].tabs.count <= 1 {
                // Last tab in worktree — remove it and show empty state
                logger.info("Last pane in last tab closed, showing empty state for worktree")
                projects[projectIdx].worktreeModels[worktreeIdx].tabs.remove(at: tabIdx)
                projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex = 0
                if isActiveWorktree {
                    refreshLayout()
                }
                return
            }
            logger.info("Last pane closed in tab \(tab.id, privacy: .public), removing tab")
            projects[projectIdx].worktreeModels[worktreeIdx].tabs.remove(at: tabIdx)
            let selIdx = projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex
            if tabIdx <= selIdx {
                projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex = max(0, selIdx - 1)
            }
            projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex = min(
                projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex,
                projects[projectIdx].worktreeModels[worktreeIdx].tabs.count - 1
            )
        } else {
            if let newRoot = projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].rootNode.removing(paneID) {
                projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].rootNode = newRoot
                let remaining = newRoot.allPaneIDs
                if !remaining.contains(projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].focusedPaneID) {
                    projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].focusedPaneID = remaining.first!
                }
            }
        }

        refreshLayout()

        // Restore focus if this is the active worktree
        if isActiveWorktree {
            let ti = projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex
            if ti < projects[projectIdx].worktreeModels[worktreeIdx].tabs.count {
                paneContainer.setFocus(projects[projectIdx].worktreeModels[worktreeIdx].tabs[ti].focusedPaneID)
            }
        }
    }

    // MARK: - Focus Navigation

    private func focusNextPane() {
        guard let project = currentProject else { return }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        let panes = project.tabs[tabIdx].rootNode.allPaneIDs
        guard panes.count > 1 else { return }
        let currentIdx = panes.firstIndex(of: project.tabs[tabIdx].focusedPaneID) ?? 0
        let nextIdx = (currentIdx + 1) % panes.count
        projects[selectedProjectIndex].tabs[tabIdx].focusedPaneID = panes[nextIdx]
        paneContainer.setFocus(panes[nextIdx])
    }

    private func focusPreviousPane() {
        guard let project = currentProject else { return }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        let panes = project.tabs[tabIdx].rootNode.allPaneIDs
        guard panes.count > 1 else { return }
        let currentIdx = panes.firstIndex(of: project.tabs[tabIdx].focusedPaneID) ?? 0
        let prevIdx = (currentIdx - 1 + panes.count) % panes.count
        projects[selectedProjectIndex].tabs[tabIdx].focusedPaneID = panes[prevIdx]
        paneContainer.setFocus(panes[prevIdx])
    }

    // MARK: - Layout

    private var layoutRetryCount = 0
    private let maxLayoutRetries = 5

    private func refreshLayout() {
        guard selectedProjectIndex < projects.count else {
            emptyStateView.mode = .noProjects
            emptyStateView.isHidden = false
            paneContainer.isHidden = true
            tabBarView.update(tabs: [], selectedIndex: 0)
            return
        }
        let project = projects[selectedProjectIndex]

        let isEmpty = project.tabs.isEmpty
        emptyStateView.mode = .noTabs
        emptyStateView.isHidden = !isEmpty
        paneContainer.isHidden = isEmpty

        if isEmpty {
            tabBarView.update(tabs: [], selectedIndex: 0)
            return
        }

        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }

        let tabData = project.tabs.map { (id: $0.id, title: $0.title) }
        tabBarView.update(tabs: tabData, selectedIndex: tabIdx)

        let rect = paneContainer.bounds
        guard rect.width > 0, rect.height > 0 else {
            guard layoutRetryCount < maxLayoutRetries else {
                layoutRetryCount = 0
                return
            }
            layoutRetryCount += 1
            DispatchQueue.main.async { [weak self] in
                self?.refreshLayout()
            }
            return
        }
        layoutRetryCount = 0
        paneContainer.layout(node: project.tabs[tabIdx].rootNode, in: rect)
        startMissingSurfaces(for: project.tabs[tabIdx])
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
            guard let project = currentProject else { break }
            let tabIdx = project.selectedTabIndex
            guard tabIdx < project.tabs.count else { break }
            removePaneFromTab(project.tabs[tabIdx].focusedPaneID)
        case .focusNext:
            focusNextPane()
        case .focusPrevious:
            focusPreviousPane()
        case .focusUp, .focusDown, .focusLeft, .focusRight:
            focusNextPane()
        case .newTab:
            createNewTab()
        case .closeTab:
            guard selectedProjectIndex < projects.count else { break }
            let tabIdx = currentSelectedTabIndex
            if tabIdx < projects[selectedProjectIndex].tabs.count {
                closeTabAt(tabIdx)
            }
        case .nextTab:
            guard selectedProjectIndex < projects.count else { break }
            let tabCount = projects[selectedProjectIndex].tabs.count
            if tabCount > 1 {
                projects[selectedProjectIndex].selectedTabIndex = (currentSelectedTabIndex + 1) % tabCount
                refreshLayout()
                let ti = projects[selectedProjectIndex].selectedTabIndex
                paneContainer.setFocus(projects[selectedProjectIndex].tabs[ti].focusedPaneID)
            }
        case .previousTab:
            guard selectedProjectIndex < projects.count else { break }
            let tabCount = projects[selectedProjectIndex].tabs.count
            if tabCount > 1 {
                projects[selectedProjectIndex].selectedTabIndex = (currentSelectedTabIndex - 1 + tabCount) % tabCount
                refreshLayout()
                let ti = projects[selectedProjectIndex].selectedTabIndex
                paneContainer.setFocus(projects[selectedProjectIndex].tabs[ti].focusedPaneID)
            }
        case .toggleFullScreen:
            window?.toggleFullScreen(nil)
        case .toggleSidebar:
            toggleSidebar()
        case .addProject:
            addProject()
        }
    }

    private func closeTabAt(_ index: Int) {
        guard selectedProjectIndex < projects.count else { return }
        guard index < projects[selectedProjectIndex].tabs.count else { return }
        let tab = projects[selectedProjectIndex].tabs[index]
        let panes = tab.rootNode.allPaneIDs
        logger.info("Closing tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)' at index \(index) (panes: \(panes.count))")
        for paneID in panes {
            let surfaceView = paneSurfaces.removeValue(forKey: paneID)
            surfaceView?.onClose = nil
            surfaceView?.destroySurface()
            paneContainer.destroyPaneView(for: paneID)
        }

        projects[selectedProjectIndex].tabs.remove(at: index)
        if projects[selectedProjectIndex].tabs.isEmpty {
            // Last tab closed — show empty state
            logger.info("Last tab closed, showing empty state for worktree")
            projects[selectedProjectIndex].selectedTabIndex = 0
            refreshLayout()
            persistProjects()
            return
        }
        let selIdx = projects[selectedProjectIndex].selectedTabIndex
        if index <= selIdx {
            projects[selectedProjectIndex].selectedTabIndex = max(0, selIdx - 1)
        }
        projects[selectedProjectIndex].selectedTabIndex = min(
            projects[selectedProjectIndex].selectedTabIndex,
            projects[selectedProjectIndex].tabs.count - 1
        )
        refreshLayout()
        persistProjects()
        let ti = projects[selectedProjectIndex].selectedTabIndex
        paneContainer.setFocus(projects[selectedProjectIndex].tabs[ti].focusedPaneID)
    }

    // MARK: - Helpers

    var focusedSurface: ghostty_surface_t? {
        guard let project = currentProject else { return nil }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return nil }
        let focusedID = project.tabs[tabIdx].focusedPaneID
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
        createNewTab()
    }

    @objc func splitHorizontal(_ sender: Any?) {
        splitPane(direction: .horizontal)
    }

    @objc func splitVertical(_ sender: Any?) {
        splitPane(direction: .vertical)
    }

    @objc func closePane(_ sender: Any?) {
        guard let project = currentProject else { return }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        removePaneFromTab(project.tabs[tabIdx].focusedPaneID)
    }

    @objc func closeTab(_ sender: Any?) {
        guard selectedProjectIndex < projects.count else { return }
        closeTabAt(currentSelectedTabIndex)
    }

    @objc func selectNextTab(_ sender: Any?) {
        handleAppAction(.nextTab)
    }

    @objc func selectPreviousTab(_ sender: Any?) {
        handleAppAction(.previousTab)
    }

    @objc func openProject(_ sender: Any?) {
        addProject()
    }

    @objc func toggleSidebarAction(_ sender: Any?) {
        toggleSidebar()
    }

}

// MARK: - TabBarDelegate

extension ManorWindowController: TabBarDelegate {
    func tabBar(_ tabBar: TabBarView, didSelectTabAt index: Int) {
        guard selectedProjectIndex < projects.count else { return }
        guard index < projects[selectedProjectIndex].tabs.count else { return }
        projects[selectedProjectIndex].selectedTabIndex = index
        refreshLayout()
        persistProjects()
        paneContainer.setFocus(projects[selectedProjectIndex].tabs[index].focusedPaneID)
    }

    func tabBar(_ tabBar: TabBarView, didCloseTabAt index: Int) {
        closeTabAt(index)
    }

    func tabBar(_ tabBar: TabBarView, didMoveTabFrom fromIndex: Int, to toIndex: Int) {
        guard selectedProjectIndex < projects.count else { return }
        let tabs = projects[selectedProjectIndex].tabs
        guard fromIndex < tabs.count, toIndex < tabs.count, fromIndex != toIndex else { return }
        let tab = projects[selectedProjectIndex].tabs.remove(at: fromIndex)
        projects[selectedProjectIndex].tabs.insert(tab, at: toIndex)
        let selIdx = projects[selectedProjectIndex].selectedTabIndex
        if selIdx == fromIndex {
            projects[selectedProjectIndex].selectedTabIndex = toIndex
        } else if fromIndex < selIdx && toIndex >= selIdx {
            projects[selectedProjectIndex].selectedTabIndex = selIdx - 1
        } else if fromIndex > selIdx && toIndex <= selIdx {
            projects[selectedProjectIndex].selectedTabIndex = selIdx + 1
        }
        persistProjects()
    }

    func tabBarDidRequestNewTab(_ tabBar: TabBarView) {
        createNewTab()
    }
}

// MARK: - ProjectSidebarDelegate

extension ManorWindowController: ProjectSidebarDelegate {
    func sidebar(_ sidebar: ProjectSidebarView, didSelectProject index: Int) {
        selectProject(at: index)
    }

    func sidebar(_ sidebar: ProjectSidebarView, didSelectWorktree worktree: WorktreeInfo, inProject index: Int) {
        guard index < projects.count else { return }
        guard let wtIdx = projects[index].worktreeModels.firstIndex(where: { $0.info.path == worktree.path }) else { return }
        selectWorktree(at: wtIdx, inProject: index)
    }

    func sidebarDidRequestAddProject(_ sidebar: ProjectSidebarView) {
        addProject()
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRequestRemoveProject index: Int) {
        removeProject(at: index)
    }

    func sidebar(_ sidebar: ProjectSidebarView, didClickPort port: ActivePort) {
        if let url = URL(string: "http://localhost:\(port.port)") {
            NSWorkspace.shared.open(url)
        }
    }

    func sidebar(_ sidebar: ProjectSidebarView, didClickPortWorktreeFor port: ActivePort) {
        guard let worktreePath = port.worktreePath else { return }
        for (pi, project) in projects.enumerated() {
            if let wtIdx = project.worktreeModels.firstIndex(where: { $0.info.path == worktreePath }) {
                selectWorktree(at: wtIdx, inProject: pi)
                return
            }
        }
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRequestCreateWorktree inProject: Int) {
        let index = inProject
        guard index < projects.count else { return }
        let project = projects[index]
        let remoteBranches = GitHelper.remoteBranches(at: project.path)

        let alert = NSAlert()
        alert.messageText = "New Worktree"
        alert.informativeText = "Enter a branch name for the new worktree."
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 88))

        let branchLabel = NSTextField(labelWithString: "Branch name:")
        branchLabel.frame = CGRect(x: 0, y: 66, width: 120, height: 18)
        let branchField = NSTextField(frame: CGRect(x: 0, y: 44, width: 320, height: 22))
        branchField.placeholderString = "feature/my-feature"
        branchField.bezelStyle = .roundedBezel

        let baseLabel = NSTextField(labelWithString: "From:")
        baseLabel.frame = CGRect(x: 0, y: 20, width: 40, height: 18)

        let popup = NSPopUpButton(frame: CGRect(x: 46, y: 18, width: 274, height: 22))
        popup.addItem(withTitle: project.defaultBranch + " (default)")
        popup.addItem(withTitle: "HEAD (current)")
        for branch in remoteBranches where branch != project.defaultBranch {
            popup.addItem(withTitle: branch)
        }

        for v in [branchLabel, branchField, baseLabel, popup] { accessory.addSubview(v) }
        alert.accessoryView = accessory

        guard let window = self.window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            guard let self = self else { return }
            let branchName = branchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branchName.isEmpty else { return }

            // Determine base branch
            let selectedTitle = popup.titleOfSelectedItem ?? ""
            var base = project.defaultBranch
            var isExisting = false
            if selectedTitle.hasPrefix("HEAD") {
                base = "HEAD"
            } else if !selectedTitle.hasSuffix("(default)") {
                base = selectedTitle
                isExisting = remoteBranches.contains(selectedTitle)
            }

            do {
                let wtPath = try GitHelper.createWorktree(
                    repoURL: project.path,
                    branch: branchName,
                    base: base,
                    isExisting: isExisting
                )
                self.refreshWorktrees(for: index)
                self.refreshGitHubData()

                // Select the new worktree
                if let wtIdx = self.projects[index].worktreeModels.firstIndex(where: { $0.info.path == wtPath }) {
                    self.selectWorktree(at: wtIdx, inProject: index)
                    // Auto-run setup script if configured
                    if let script = self.projects[index].setupScript, !script.isEmpty {
                        self.createNewTab(runningScript: script)
                    }
                }
                self.persistProjects()
            } catch {
                let errAlert = NSAlert(error: error)
                errAlert.runModal()
            }
        }
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRequestDeleteWorktree worktree: WorktreeInfo, inProject: Int) {
        let index = inProject
        guard index < projects.count, !worktree.isMain else { return }
        let project = projects[index]

        let alert = NSAlert()
        alert.messageText = "Delete worktree \"\(worktree.branch)\"?"
        alert.informativeText = "This will remove the worktree directory."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        alert.buttons[0].hasDestructiveAction = true

        let checkbox = NSButton(checkboxWithTitle: "Also delete branch \"\(worktree.branch)\"", target: nil, action: nil)
        checkbox.frame = CGRect(x: 0, y: 0, width: 300, height: 20)
        alert.accessoryView = checkbox

        guard let window = self.window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            guard let self = self else { return }

            // Run teardown script first (best-effort, synchronous)
            if let script = self.projects[index].teardownScript, !script.isEmpty {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/sh")
                p.arguments = ["-c", script]
                let dir = worktree.path.isEmpty ? project.path.path : worktree.path
                p.currentDirectoryURL = URL(fileURLWithPath: dir)
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                try? p.run()
                p.waitUntilExit()
            }

            // Close terminal sessions for this worktree
            self.destroyWorktreeSessions(path: worktree.path, projectIndex: index)

            do {
                try GitHelper.deleteWorktree(
                    path: worktree.path,
                    repoURL: project.path
                )
            } catch {
                // Try force-remove
                let forceAlert = NSAlert()
                forceAlert.messageText = "Worktree has uncommitted changes"
                forceAlert.informativeText = error.localizedDescription + "\n\nForce remove anyway?"
                forceAlert.addButton(withTitle: "Force Remove")
                forceAlert.addButton(withTitle: "Cancel")
                guard forceAlert.runModal() == .alertFirstButtonReturn else { return }
                do {
                    try GitHelper.deleteWorktree(path: worktree.path, repoURL: project.path, force: true)
                } catch let forceErr {
                    NSAlert(error: forceErr).runModal()
                    return
                }
            }

            if checkbox.state == NSControl.StateValue.on {
                // Delete branch - try normal first, then force
                do {
                    try GitHelper.deleteBranch(worktree.branch, at: project.path)
                } catch {
                    let branchAlert = NSAlert()
                    branchAlert.messageText = "Branch not fully merged"
                    branchAlert.informativeText = "Force delete branch \"\(worktree.branch)\"?"
                    branchAlert.addButton(withTitle: "Force Delete")
                    branchAlert.addButton(withTitle: "Skip")
                    if branchAlert.runModal() == .alertFirstButtonReturn {
                        try? GitHelper.deleteBranch(worktree.branch, at: project.path, force: true)
                    }
                }
            }

            self.refreshWorktrees(for: index)
            self.persistProjects()
        }
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRenameWorktree worktree: WorktreeInfo, newName: String, inProject index: Int) {
        guard index < projects.count else { return }
        guard let wtIdx = projects[index].worktreeModels.firstIndex(where: { $0.info.path == worktree.path }) else { return }
        projects[index].worktreeModels[wtIdx].displayName = newName.isEmpty ? nil : newName
        refreshSidebar()
        persistProjects()
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRequestRunCommand worktree: WorktreeInfo, inProject index: Int) {
        guard index < projects.count else { return }
        let project = projects[index]

        // Find run command: per-worktree override or project default
        let command: String?
        if let wtIdx = project.worktreeModels.firstIndex(where: { $0.info.path == worktree.path }) {
            command = project.worktreeModels[wtIdx].runCommand ?? project.defaultRunCommand
        } else {
            command = project.defaultRunCommand
        }

        guard let cmd = command, !cmd.isEmpty else { return }
        createNewTab(runningScript: cmd)
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRequestProjectSettings index: Int) {
        guard index < projects.count else { return }
        let project = projects[index]

        let vc = ProjectSettingsViewController()
        vc.projectName = project.name
        vc.setupScript = project.setupScript ?? ""
        vc.teardownScript = project.teardownScript ?? ""
        vc.defaultRunCommand = project.defaultRunCommand ?? ""

        let panel = NSPanel(contentViewController: vc)
        panel.title = "Project Settings"
        panel.styleMask = [.titled, .closable]
        panel.setContentSize(NSSize(width: 420, height: 300))

        guard let window = self.window else { return }

        vc.onSave = { [weak self, weak panel] in
            guard let self = self, let panel = panel else { return }
            if let vc = panel.contentViewController as? ProjectSettingsViewController {
                let vals = vc.collectValues()
                self.projects[index].setupScript = vals.setup
                self.projects[index].teardownScript = vals.teardown
                self.projects[index].defaultRunCommand = vals.run
                self.refreshSidebar()
                self.persistProjects()
            }
            window.endSheet(panel, returnCode: .OK)
        }

        vc.onCancel = { [weak panel] in
            guard let panel = panel else { return }
            window.endSheet(panel, returnCode: .cancel)
        }

        window.beginSheet(panel) { _ in }
    }

    func sidebar(_ sidebar: ProjectSidebarView, didRequestCheckoutDefaultBranch inProject: Int) {
        let index = inProject
        guard index < projects.count else { return }
        let project = projects[index]
        let branch = project.defaultBranch

        do {
            let wtPath = try GitHelper.createWorktree(
                repoURL: project.path,
                branch: branch,
                isExisting: true
            )
            refreshWorktrees(for: index)
            if let wtIdx = projects[index].worktreeModels.firstIndex(where: { $0.info.path == wtPath }) {
                selectWorktree(at: wtIdx, inProject: index)
            }
            persistProjects()
        } catch {
            NSAlert(error: error).runModal()
        }
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
                if target.tag == GHOSTTY_TARGET_SURFACE {
                    guard let surface = target.target.surface else { return false }
                    if let id = paneID(for: surface) {
                        // Search across all projects and worktrees
                        for pi in 0..<projects.count {
                            for wi in 0..<projects[pi].worktreeModels.count {
                                for ti in 0..<projects[pi].worktreeModels[wi].tabs.count {
                                    if projects[pi].worktreeModels[wi].tabs[ti].rootNode.contains(id) {
                                        projects[pi].worktreeModels[wi].tabs[ti].title = title
                                        // Only update tab bar if this is the active project+worktree
                                        if pi == selectedProjectIndex && wi == projects[pi].selectedWorktreeIndex {
                                            let tabData = projects[pi].worktreeModels[wi].tabs.map { (id: $0.id, title: $0.title) }
                                            tabBarView.update(tabs: tabData, selectedIndex: projects[pi].worktreeModels[wi].selectedTabIndex)
                                        }
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
                    removePaneFromTab(id)
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
                paneCWD[id] = cwd
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
            }
            return true

        default:
            return false
        }
    }

    func ghosttyApp(_ app: GhosttyApp, closeSurface surface: ghostty_surface_t, needsConfirm: Bool) {
        if let id = paneID(for: surface) {
            removePaneFromTab(id)
        }
    }
}
