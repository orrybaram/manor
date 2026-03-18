import AppKit
import CGhosttyKit
import Combine
import ManorCore
import os.log

// MARK: - Empty State Mode

enum EmptyStateMode {
    case noProjects
    case noTabs
}

/// Thin facade over domain-specific managers. Views use `@EnvironmentObject var appState: AppState`
/// and call methods here; AppState delegates to the appropriate manager.
///
/// Each manager is an `ObservableObject` whose `objectWillChange` is forwarded so that
/// any `@Published` change in any manager triggers a view update through AppState.
@MainActor
final class AppState: ObservableObject {
    // MARK: - Managers

    let projectManager = ProjectManager()
    let tabManager = TabManager()
    let paneManager = PaneManager()
    let sidebarManager = SidebarManager()
    let portManager = PortManager()
    let dialogPresenter = DialogPresenter()

    // Window reference for presenting sheets/alerts
    weak var window: NSWindow?

    private var cancellables: Set<AnyCancellable> = []

    init() {
        // Wire back-references
        projectManager.appState = self
        tabManager.appState = self
        paneManager.appState = self
        dialogPresenter.appState = self

        // Forward objectWillChange from all managers
        projectManager.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        tabManager.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        paneManager.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        sidebarManager.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        portManager.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
    }

    // MARK: - Forwarded Published State

    var projects: [ProjectModel] {
        get { projectManager.projects }
        set { projectManager.projects = newValue }
    }

    var selectedProjectID: UUID? {
        get { projectManager.selectedProjectID }
        set { projectManager.selectedProjectID = newValue }
    }

    var activePorts: [ActivePort] {
        get { portManager.activePorts }
        set { portManager.activePorts = newValue }
    }

    var sidebarVisible: Bool {
        get { sidebarManager.sidebarVisible }
        set { sidebarManager.sidebarVisible = newValue }
    }

    var sidebarWidth: CGFloat {
        get { sidebarManager.sidebarWidth }
        set { sidebarManager.sidebarWidth = newValue }
    }

    var paneCWD: [PaneID: String] {
        get { paneManager.paneCWD }
        set { paneManager.paneCWD = newValue }
    }

    var paneSurfaces: [PaneID: GhosttySurfaceView] {
        get { paneManager.paneSurfaces }
        set { paneManager.paneSurfaces = newValue }
    }

    // MARK: - Computed Properties

    var selectedProjectIndex: Int {
        get { projectManager.selectedProjectIndex }
        set { projectManager.selectedProjectIndex = newValue }
    }

    var emptyStateMode: EmptyStateMode {
        if projects.isEmpty || currentProject == nil { return .noProjects }
        return .noTabs
    }

    var currentProject: ProjectModel? { projectManager.currentProject }

    var currentTabs: [TabModel] { projectManager.currentTabs }

    var currentSelectedTabIndex: Int {
        get { projectManager.currentSelectedTabIndex }
        set { projectManager.currentSelectedTabIndex = newValue }
    }

    // MARK: - Focus

    func focusPane(_ paneID: PaneID) { paneManager.focusPane(paneID) }

    // MARK: - Pane Ratio

    func updatePaneRatio(at path: [Int], newRatio: CGFloat) {
        paneManager.updatePaneRatio(at: path, newRatio: newRatio)
    }

    // MARK: - Project Lifecycle

    func updateCurrentProject(_ project: ProjectModel) { projectManager.updateCurrentProject(project) }
    func loadProjects() { projectManager.loadProjects() }
    func persistProjects() { projectManager.persistProjects() }
    func persistProjectsNow() { projectManager.persistProjectsNow() }
    func addProject() { projectManager.addProject() }
    func removeProject(at index: Int) { projectManager.removeProject(at: index) }

    // MARK: - Project / Worktree Selection

    func selectProject(at index: Int) { projectManager.selectProject(at: index) }

    func selectWorktree(at worktreeIndex: Int, inProject projectIndex: Int) {
        projectManager.selectWorktree(at: worktreeIndex, inProject: projectIndex)
    }

    func selectWorktreeFromSidebar(_ worktree: WorktreeInfo, inProject index: Int) {
        projectManager.selectWorktreeFromSidebar(worktree, inProject: index)
    }

    // MARK: - Worktree Management

    func refreshWorktrees() { projectManager.refreshWorktrees() }
    func refreshWorktrees(for projectIndex: Int) { projectManager.refreshWorktrees(for: projectIndex) }

    func destroyWorktreeSessions(path: String, projectIndex: Int) {
        projectManager.destroyWorktreeSessions(path: path, projectIndex: projectIndex)
    }

    // MARK: - Tab Management

    func createNewTab(runningScript: String? = nil) { tabManager.createNewTab(runningScript: runningScript) }
    func closeTabAt(_ index: Int) { tabManager.closeTabAt(index) }
    func selectTab(at index: Int) { tabManager.selectTab(at: index) }
    func selectNextTab() { tabManager.selectNextTab() }
    func selectPreviousTab() { tabManager.selectPreviousTab() }
    func moveTab(from fromIndex: Int, to toIndex: Int) { tabManager.moveTab(from: fromIndex, to: toIndex) }

    // MARK: - Pane Management

    func splitPane(direction: SplitDirection) { paneManager.splitPane(direction: direction) }
    func removePaneFromTab(_ paneID: PaneID) { paneManager.removePaneFromTab(paneID) }
    func focusNextPane() { paneManager.focusNextPane() }
    func focusPreviousPane() { paneManager.focusPreviousPane() }
    func startMissingSurfaces() { paneManager.startMissingSurfaces() }

    func startSurfaceForPane(
        _ paneID: PaneID,
        config: ghostty_surface_config_s? = nil,
        workingDirectory: URL? = nil,
        initialInput: String? = nil
    ) {
        paneManager.startSurfaceForPane(paneID, config: config, workingDirectory: workingDirectory, initialInput: initialInput)
    }

    // MARK: - Sidebar

    func toggleSidebar() { sidebarManager.toggleSidebar() }

    func updatePortScannerWorktreePaths() {
        portManager.updateWorktreePaths(projects.flatMap { $0.worktreeModels.map { $0.info.path } })
    }

    // MARK: - Port Scanner

    func startPortScanner() {
        portManager.startPortScanner()
        updatePortScannerWorktreePaths()
    }

    // MARK: - GitHub Refresh

    func startGitHubRefresh() { projectManager.startGitHubRefresh() }
    func stopGitHubRefresh() { projectManager.stopGitHubRefresh() }
    func refreshGitHubData() { projectManager.refreshGitHubData() }

    // MARK: - Sidebar Data

    func sidebarProjectEntries() -> [SidebarProjectsViewModel.ProjectEntry] {
        projectManager.sidebarProjectEntries()
    }

    // MARK: - Sidebar Actions (Dialogs)

    func requestCreateWorktree(inProject index: Int) { dialogPresenter.requestCreateWorktree(inProject: index) }
    func requestDeleteWorktree(_ worktree: WorktreeInfo, inProject index: Int) { dialogPresenter.requestDeleteWorktree(worktree, inProject: index) }
    func requestProjectSettings(at index: Int) { dialogPresenter.requestProjectSettings(at: index) }
    func requestCheckoutDefaultBranch(inProject index: Int) { dialogPresenter.requestCheckoutDefaultBranch(inProject: index) }

    func renameWorktree(_ worktree: WorktreeInfo, newName: String, inProject index: Int) {
        dialogPresenter.renameWorktree(worktree, newName: newName, inProject: index)
    }

    func runWorktreeCommand(_ worktree: WorktreeInfo, inProject index: Int) {
        dialogPresenter.runWorktreeCommand(worktree, inProject: index)
    }

    func clickPort(_ port: ActivePort) { portManager.clickPort(port) }

    func clickPortWorktree(_ port: ActivePort) {
        guard let worktreePath = port.worktreePath else { return }
        for (pi, project) in projects.enumerated() {
            if let wtIdx = project.worktreeModels.firstIndex(where: { $0.info.path == worktreePath }) {
                selectWorktree(at: wtIdx, inProject: pi)
                return
            }
        }
    }
}
