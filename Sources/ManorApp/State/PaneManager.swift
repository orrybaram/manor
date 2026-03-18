import AppKit
import CGhosttyKit
import Combine
import ManorCore
import os.log

private let logger = Logger(subsystem: "com.manor.app", category: "panes")

@MainActor
final class PaneManager: ObservableObject {
    @Published var paneCWD: [PaneID: String] = [:]

    // NOT @Published — imperative, like React refs
    var paneSurfaces: [PaneID: GhosttySurfaceView] = [:]

    // Pending surface queue: surfaces waiting for their view to appear
    struct PendingSurface {
        var config: ghostty_surface_config_s?
        var workingDirectory: URL?
        var initialInput: String?
    }
    var pendingSurfaces: [PaneID: PendingSurface] = [:]

    // Back-reference for cross-manager access
    weak var appState: AppState?

    private var projectManager: ProjectManager? { appState?.projectManager }

    // MARK: - Focus

    func focusPane(_ paneID: PaneID) {
        if let view = paneSurfaces[paneID] {
            view.window?.makeFirstResponder(view)
        }
    }

    // MARK: - Pane Ratio

    func updatePaneRatio(at path: [Int], newRatio: CGFloat) {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let pi = pm.selectedProjectIndex
        let wi = pm.projects[pi].selectedWorktreeIndex
        let tabIdx = pm.projects[pi].worktreeModels[wi].selectedTabIndex
        guard tabIdx < pm.projects[pi].worktreeModels[wi].tabs.count else { return }
        pm.projects[pi].worktreeModels[wi].tabs[tabIdx].rootNode =
            pm.projects[pi].worktreeModels[wi].tabs[tabIdx].rootNode.withUpdatedRatio(at: path, newRatio: newRatio)
    }

    // MARK: - Split

    func splitPane(direction: SplitDirection) {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let tabIdx = pm.currentSelectedTabIndex
        guard tabIdx < pm.projects[pm.selectedProjectIndex].tabs.count else { return }
        let focusedID = pm.projects[pm.selectedProjectIndex].tabs[tabIdx].focusedPaneID
        let newPaneID = PaneID()

        pm.projects[pm.selectedProjectIndex].tabs[tabIdx].rootNode =
            pm.projects[pm.selectedProjectIndex].tabs[tabIdx].rootNode.insertSplit(
                at: focusedID,
                direction: direction,
                newID: newPaneID
            )

        pm.persistProjects()

        var config: ghostty_surface_config_s? = nil
        if let focusedSurfaceView = paneSurfaces[focusedID],
           let surface = focusedSurfaceView.surface {
            config = ghostty_surface_inherited_config(surface, GHOSTTY_SURFACE_CONTEXT_SPLIT)
        }

        DispatchQueue.main.async { [weak self] in
            self?.startSurfaceForPane(newPaneID, config: config)
        }
    }

    // MARK: - Remove Pane

    func removePaneFromTab(_ paneID: PaneID) {
        guard let pm = projectManager else { return }

        var foundProjectIdx: Int?
        var foundWorktreeIdx: Int?
        var foundTabIdx: Int?

        outer: for pi in 0..<pm.projects.count {
            for wi in 0..<pm.projects[pi].worktreeModels.count {
                for ti in 0..<pm.projects[pi].worktreeModels[wi].tabs.count {
                    if pm.projects[pi].worktreeModels[wi].tabs[ti].rootNode.contains(paneID) {
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
        let tab = pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx]
        let allPanes = tab.rootNode.allPaneIDs

        let surfaceView = paneSurfaces.removeValue(forKey: paneID)
        surfaceView?.onClose = nil
        surfaceView?.destroySurface()

        let isActiveWorktree = projectIdx == pm.selectedProjectIndex &&
            worktreeIdx == pm.projects[projectIdx].selectedWorktreeIndex

        if allPanes.count <= 1 {
            if pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs.count <= 1 {
                logger.info("Last pane in last tab closed, showing empty state for worktree")
                pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs.remove(at: tabIdx)
                pm.projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex = 0
                return
            }
            logger.info("Last pane closed in tab \(tab.id, privacy: .public), removing tab")
            pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs.remove(at: tabIdx)
            let selIdx = pm.projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex
            if tabIdx <= selIdx {
                pm.projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex = max(0, selIdx - 1)
            }
            pm.projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex = min(
                pm.projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex,
                pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs.count - 1
            )
        } else {
            if let newRoot = pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].rootNode.removing(paneID) {
                pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].rootNode = newRoot
                let remaining = newRoot.allPaneIDs
                if !remaining.contains(pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].focusedPaneID) {
                    pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs[tabIdx].focusedPaneID = remaining.first!
                }
            }
        }

        if isActiveWorktree {
            let ti = pm.projects[projectIdx].worktreeModels[worktreeIdx].selectedTabIndex
            if ti < pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs.count {
                focusPane(pm.projects[projectIdx].worktreeModels[worktreeIdx].tabs[ti].focusedPaneID)
            }
        }
    }

    // MARK: - Focus Navigation

    func focusNextPane() {
        guard let pm = projectManager, let project = pm.currentProject else { return }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        let panes = project.tabs[tabIdx].rootNode.allPaneIDs
        guard panes.count > 1 else { return }
        let currentIdx = panes.firstIndex(of: project.tabs[tabIdx].focusedPaneID) ?? 0
        let nextIdx = (currentIdx + 1) % panes.count
        pm.projects[pm.selectedProjectIndex].tabs[tabIdx].focusedPaneID = panes[nextIdx]
        focusPane(panes[nextIdx])
    }

    func focusPreviousPane() {
        guard let pm = projectManager, let project = pm.currentProject else { return }
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        let panes = project.tabs[tabIdx].rootNode.allPaneIDs
        guard panes.count > 1 else { return }
        let currentIdx = panes.firstIndex(of: project.tabs[tabIdx].focusedPaneID) ?? 0
        let prevIdx = (currentIdx - 1 + panes.count) % panes.count
        pm.projects[pm.selectedProjectIndex].tabs[tabIdx].focusedPaneID = panes[prevIdx]
        focusPane(panes[prevIdx])
    }

    // MARK: - Surface Lifecycle

    func startMissingSurfaces() {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let project = pm.projects[pm.selectedProjectIndex]
        let tabIdx = project.selectedTabIndex
        guard tabIdx < project.tabs.count else { return }
        let tab = project.tabs[tabIdx]
        let wtIdx = project.selectedWorktreeIndex
        let wtPath = project.worktreeModels[wtIdx].info.path
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

    /// Called by GhosttySurfaceRepresentable when a view registers for a pane.
    func surfaceViewDidRegister(_ paneID: PaneID) {
        guard let pending = pendingSurfaces.removeValue(forKey: paneID) else { return }
        startSurfaceForPane(paneID, config: pending.config, workingDirectory: pending.workingDirectory, initialInput: pending.initialInput)
    }

    func startSurfaceForPane(
        _ paneID: PaneID,
        config: ghostty_surface_config_s? = nil,
        workingDirectory: URL? = nil,
        initialInput: String? = nil
    ) {
        guard let surfaceView = paneSurfaces[paneID] else {
            // View doesn't exist yet — queue for when it registers
            pendingSurfaces[paneID] = PendingSurface(
                config: config,
                workingDirectory: workingDirectory,
                initialInput: initialInput
            )
            return
        }

        guard let app = GhosttyApp.shared.app else {
            logger.warning("startSurfaceForPane: GhosttyApp not initialized")
            return
        }

        guard surfaceView.surface == nil else { return }

        var surfaceConfig = config ?? GhosttyApp.shared.newSurfaceConfig()

        let histFile = ProjectPersistence.historyFile(for: paneID)
        try? FileManager.default.createDirectory(
            at: ProjectPersistence.sessionsDirectory,
            withIntermediateDirectories: true
        )
        let zdotdir = ProjectPersistence.setupZdotdir()
        let realZdotdir = ProcessInfo.processInfo.environment["ZDOTDIR"] ?? NSHomeDirectory()
        let envVarPairs: [(key: String, value: String)] = [
            ("HISTFILE", histFile.path),
            ("MANOR_HISTFILE", histFile.path),
            ("GHOSTTY_ZSH_ZDOTDIR", zdotdir.path),
            ("REAL_ZDOTDIR", realZdotdir),
            ("HISTSIZE", "10000"),
            ("SAVEHIST", "10000"),
            ("HISTFILESIZE", "10000"),
        ]

        withEnvVarsC(envVarPairs) { envPtr, envCount in
            surfaceConfig.env_vars = envPtr
            surfaceConfig.env_var_count = envCount

            func doCreate() {
                surfaceView.createSurface(app: app, config: surfaceConfig)
                surfaceView.onClose = { [weak self] in
                    MainActor.assumeIsolated {
                        self?.removePaneFromTab(paneID)
                    }
                }
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
        focusPane(paneID)
    }

    // MARK: - Bulk Destroy

    func destroyPanes(_ paneIDs: [PaneID]) {
        for paneID in paneIDs {
            let surfaceView = paneSurfaces.removeValue(forKey: paneID)
            surfaceView?.onClose = nil
            surfaceView?.destroySurface()
        }
    }

    func destroyAllSurfaces(for project: ProjectModel) {
        for wt in project.worktreeModels {
            destroyAllSurfaces(forTabs: wt.tabs)
        }
    }

    func destroyAllSurfaces(forTabs tabs: [TabModel]) {
        for tab in tabs {
            destroyPanes(tab.rootNode.allPaneIDs)
        }
    }

    // MARK: - Private

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
}
