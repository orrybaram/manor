import AppKit
import Combine
import ManorCore
import os.log

private let logger = Logger(subsystem: "com.manor.app", category: "projects")

@MainActor
final class ProjectManager: ObservableObject {
    @Published var projects: [ProjectModel] = []
    @Published var selectedProjectID: UUID?

    var githubRefreshTimer: DispatchSourceTimer?
    private var persistDebounce: DispatchWorkItem?

    // Back-reference for cross-manager access
    weak var appState: AppState?

    // MARK: - Computed Properties

    var selectedProjectIndex: Int {
        get {
            if let id = selectedProjectID,
               let idx = projects.firstIndex(where: { $0.id == id }) {
                return idx
            }
            return 0
        }
        set {
            guard newValue < projects.count else { return }
            selectedProjectID = projects[newValue].id
        }
    }

    var currentProject: ProjectModel? {
        if let id = selectedProjectID {
            return projects.first(where: { $0.id == id })
        }
        return projects.first
    }

    var currentTabs: [TabModel] {
        currentProject?.tabs ?? []
    }

    var currentSelectedTabIndex: Int {
        get { currentProject?.selectedTabIndex ?? 0 }
        set {
            guard selectedProjectIndex < projects.count else { return }
            projects[selectedProjectIndex].selectedTabIndex = newValue
        }
    }

    // MARK: - Lifecycle

    func loadProjects() {
        let (restored, restoredCWD) = ProjectPersistence.restore()
        projects = restored
        selectedProjectID = projects.first?.id
        appState?.paneManager.paneCWD = restoredCWD
        appState?.paneManager.startMissingSurfaces()
    }

    func persistProjects() {
        persistDebounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let paneCWD = self.appState?.paneManager.paneCWD ?? [:]
            ProjectPersistence.persist(projects: self.projects, selectedIndex: self.selectedProjectIndex, paneCWD: paneCWD)
        }
        persistDebounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    func persistProjectsNow() {
        persistDebounce?.cancel()
        persistDebounce = nil
        let paneCWD = appState?.paneManager.paneCWD ?? [:]
        ProjectPersistence.persist(projects: projects, selectedIndex: selectedProjectIndex, paneCWD: paneCWD)
    }

    func updateCurrentProject(_ project: ProjectModel) {
        guard selectedProjectIndex < projects.count else { return }
        projects[selectedProjectIndex] = project
        persistProjects()
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
            self.persistProjects()
            self.refreshGitHubData()
        }
    }

    func removeProject(at index: Int) {
        guard index < projects.count else { return }
        let project = projects[index]

        // Destroy all surfaces for this project (across all worktrees)
        appState?.paneManager.destroyAllSurfaces(for: project)

        projects.remove(at: index)

        if index <= selectedProjectIndex {
            selectedProjectIndex = max(0, selectedProjectIndex - 1)
        }
        if !projects.isEmpty {
            selectedProjectIndex = min(selectedProjectIndex, projects.count - 1)
        }

        persistProjects()

        if let project = currentProject, currentSelectedTabIndex < project.tabs.count {
            appState?.paneManager.focusPane(project.tabs[currentSelectedTabIndex].focusedPaneID)
        }
    }

    // MARK: - Project / Worktree Selection

    func selectProject(at index: Int) {
        guard index < projects.count, index != selectedProjectIndex else { return }
        selectedProjectIndex = index
        refreshWorktrees()

        let wtIdx = projects[selectedProjectIndex].selectedWorktreeIndex
        selectWorktree(at: wtIdx, inProject: selectedProjectIndex)
    }

    func selectWorktree(at worktreeIndex: Int, inProject projectIndex: Int) {
        guard projectIndex < projects.count,
              worktreeIndex < projects[projectIndex].worktreeModels.count else { return }

        if projectIndex != selectedProjectIndex {
            selectedProjectIndex = projectIndex
        }
        projects[selectedProjectIndex].selectedWorktreeIndex = worktreeIndex

        let wt = projects[selectedProjectIndex].worktreeModels[worktreeIndex]

        appState?.paneManager.startMissingSurfaces()

        if !wt.tabs.isEmpty {
            let tabIdx = wt.selectedTabIndex
            if tabIdx < wt.tabs.count {
                appState?.paneManager.focusPane(wt.tabs[tabIdx].focusedPaneID)
            }
        }
    }

    func selectWorktreeFromSidebar(_ worktree: WorktreeInfo, inProject index: Int) {
        guard index < projects.count else { return }
        guard let wtIdx = projects[index].worktreeIndex(matching: worktree) else {
            selectProject(at: index)
            return
        }
        selectWorktree(at: wtIdx, inProject: index)
    }

    // MARK: - Worktree Management

    func refreshWorktrees() {
        refreshWorktrees(for: selectedProjectIndex)
    }

    func refreshWorktrees(for projectIndex: Int) {
        guard projectIndex < projects.count else { return }
        let url = projects[projectIndex].path
        let gitWorktrees = GitHelper.listWorktrees(at: url)

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
    }

    func destroyWorktreeSessions(path: String, projectIndex: Int) {
        guard projectIndex < projects.count else { return }
        guard let wtIdx = projects[projectIndex].worktreeModels.firstIndex(where: { $0.info.path == path }) else { return }
        let wt = projects[projectIndex].worktreeModels[wtIdx]

        appState?.paneManager.destroyAllSurfaces(forTabs: wt.tabs)

        projects[projectIndex].worktreeModels[wtIdx].tabs = []
        projects[projectIndex].worktreeModels[wtIdx].selectedTabIndex = 0
    }

    // MARK: - GitHub Refresh

    func startGitHubRefresh() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: 60)
        timer.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.refreshGitHubData()
            }
        }
        timer.resume()
        githubRefreshTimer = timer
    }

    func stopGitHubRefresh() {
        githubRefreshTimer?.cancel()
        githubRefreshTimer = nil
    }

    func refreshGitHubData() {
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
                    updates.append((pi: proj.pi, wi: wt.wi, prInfo: pr, diffStat: diff))
                }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for u in updates {
                    guard u.pi < self.projects.count,
                          u.wi < self.projects[u.pi].worktreeModels.count else { continue }
                    self.projects[u.pi].worktreeModels[u.wi].prInfo = u.prInfo
                    self.projects[u.pi].worktreeModels[u.wi].diffStat = u.diffStat
                }
            }
        }
    }

    // MARK: - Sidebar Data

    func sidebarProjectEntries() -> [SidebarProjectsViewModel.ProjectEntry] {
        return projects.map { project in
            let selectedWtPath: String? = project.worktreeModels.isEmpty
                ? nil
                : project.worktreeModels[project.selectedWorktreeIndex].info.path

            var items = project.worktreeModels.map { wt in
                WorktreeViewItem(
                    info: wt.info,
                    label: wt.label,
                    hasRunCommand: wt.runCommand != nil || project.defaultRunCommand != nil,
                    prInfo: wt.prInfo,
                    diffStat: wt.diffStat
                )
            }

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
    }
}
