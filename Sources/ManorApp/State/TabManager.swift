import Foundation
import ManorCore
import os.log

private let logger = Logger(subsystem: "com.manor.app", category: "tabs")

@MainActor
final class TabManager: ObservableObject {
    // Back-reference for cross-manager access
    weak var appState: AppState?

    private var projectManager: ProjectManager? { appState?.projectManager }
    private var paneManager: PaneManager? { appState?.paneManager }

    func createNewTab(runningScript: String? = nil) {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let paneID = PaneID()
        let tabCount = pm.projects[pm.selectedProjectIndex].tabs.count
        let tab = TabModel(paneID: paneID, title: "Terminal \(tabCount + 1)")
        pm.projects[pm.selectedProjectIndex].tabs.append(tab)
        pm.projects[pm.selectedProjectIndex].selectedTabIndex = pm.projects[pm.selectedProjectIndex].tabs.count - 1
        logger.info("Created tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)' (total: \(tabCount + 1))")
        pm.persistProjects()

        let wtIdx = pm.projects[pm.selectedProjectIndex].selectedWorktreeIndex
        let workDir = URL(fileURLWithPath: pm.projects[pm.selectedProjectIndex].worktreeModels[wtIdx].info.path)
        DispatchQueue.main.async { [weak self] in
            self?.paneManager?.startSurfaceForPane(paneID, workingDirectory: workDir, initialInput: runningScript)
        }
    }

    func closeTabAt(_ index: Int) {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        guard index < pm.projects[pm.selectedProjectIndex].tabs.count else { return }
        let tab = pm.projects[pm.selectedProjectIndex].tabs[index]
        let panes = tab.rootNode.allPaneIDs
        logger.info("Closing tab \(tab.id, privacy: .public) '\(tab.title, privacy: .public)' at index \(index) (panes: \(panes.count))")

        paneManager?.destroyPanes(panes)

        pm.projects[pm.selectedProjectIndex].tabs.remove(at: index)
        if pm.projects[pm.selectedProjectIndex].tabs.isEmpty {
            logger.info("Last tab closed, showing empty state for worktree")
            pm.projects[pm.selectedProjectIndex].selectedTabIndex = 0
            pm.persistProjects()
            return
        }
        let selIdx = pm.projects[pm.selectedProjectIndex].selectedTabIndex
        if index <= selIdx {
            pm.projects[pm.selectedProjectIndex].selectedTabIndex = max(0, selIdx - 1)
        }
        pm.projects[pm.selectedProjectIndex].selectedTabIndex = min(
            pm.projects[pm.selectedProjectIndex].selectedTabIndex,
            pm.projects[pm.selectedProjectIndex].tabs.count - 1
        )
        pm.persistProjects()
        let ti = pm.projects[pm.selectedProjectIndex].selectedTabIndex
        paneManager?.focusPane(pm.projects[pm.selectedProjectIndex].tabs[ti].focusedPaneID)
    }

    func selectTab(at index: Int) {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        guard index < pm.projects[pm.selectedProjectIndex].tabs.count else { return }
        pm.projects[pm.selectedProjectIndex].selectedTabIndex = index
        pm.persistProjects()
        paneManager?.startMissingSurfaces()
        paneManager?.focusPane(pm.projects[pm.selectedProjectIndex].tabs[index].focusedPaneID)
    }

    func selectNextTab() {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let tabCount = pm.projects[pm.selectedProjectIndex].tabs.count
        guard tabCount > 1 else { return }
        pm.projects[pm.selectedProjectIndex].selectedTabIndex = (pm.currentSelectedTabIndex + 1) % tabCount
        let ti = pm.projects[pm.selectedProjectIndex].selectedTabIndex
        paneManager?.startMissingSurfaces()
        paneManager?.focusPane(pm.projects[pm.selectedProjectIndex].tabs[ti].focusedPaneID)
    }

    func selectPreviousTab() {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let tabCount = pm.projects[pm.selectedProjectIndex].tabs.count
        guard tabCount > 1 else { return }
        pm.projects[pm.selectedProjectIndex].selectedTabIndex = (pm.currentSelectedTabIndex - 1 + tabCount) % tabCount
        let ti = pm.projects[pm.selectedProjectIndex].selectedTabIndex
        paneManager?.startMissingSurfaces()
        paneManager?.focusPane(pm.projects[pm.selectedProjectIndex].tabs[ti].focusedPaneID)
    }

    func moveTab(from fromIndex: Int, to toIndex: Int) {
        guard let pm = projectManager else { return }
        guard pm.selectedProjectIndex < pm.projects.count else { return }
        let tabs = pm.projects[pm.selectedProjectIndex].tabs
        guard fromIndex < tabs.count, toIndex < tabs.count, fromIndex != toIndex else { return }
        let tab = pm.projects[pm.selectedProjectIndex].tabs.remove(at: fromIndex)
        pm.projects[pm.selectedProjectIndex].tabs.insert(tab, at: toIndex)
        let selIdx = pm.projects[pm.selectedProjectIndex].selectedTabIndex
        if selIdx == fromIndex {
            pm.projects[pm.selectedProjectIndex].selectedTabIndex = toIndex
        } else if fromIndex < selIdx && toIndex >= selIdx {
            pm.projects[pm.selectedProjectIndex].selectedTabIndex = selIdx - 1
        } else if fromIndex > selIdx && toIndex <= selIdx {
            pm.projects[pm.selectedProjectIndex].selectedTabIndex = selIdx + 1
        }
        pm.persistProjects()
    }
}
