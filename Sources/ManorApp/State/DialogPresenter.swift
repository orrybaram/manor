import AppKit
import ManorCore

@MainActor
final class DialogPresenter {
    // Back-reference for cross-manager access
    weak var appState: AppState?

    private var projectManager: ProjectManager? { appState?.projectManager }
    private var paneManager: PaneManager? { appState?.paneManager }
    private var window: NSWindow? { appState?.window }

    // MARK: - Worktree Dialogs

    func requestCreateWorktree(inProject index: Int) {
        guard let pm = projectManager, index < pm.projects.count, let window else { return }
        let project = pm.projects[index]
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

        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            guard let self = self, let pm = self.projectManager else { return }
            let branchName = branchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branchName.isEmpty else { return }

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
                pm.refreshWorktrees(for: index)
                pm.refreshGitHubData()

                if let wtIdx = pm.projects[index].worktreeModels.firstIndex(where: { $0.info.path == wtPath }) {
                    pm.selectWorktree(at: wtIdx, inProject: index)
                    if let script = pm.projects[index].setupScript, !script.isEmpty {
                        self.appState?.createNewTab(runningScript: script)
                    }
                }
                pm.persistProjects()
            } catch {
                let errAlert = NSAlert(error: error)
                errAlert.runModal()
            }
        }
    }

    func requestDeleteWorktree(_ worktree: WorktreeInfo, inProject index: Int) {
        guard let pm = projectManager, index < pm.projects.count, !worktree.isMain, let window else { return }
        let project = pm.projects[index]

        let alert = NSAlert()
        alert.messageText = "Delete worktree \"\(worktree.branch)\"?"
        alert.informativeText = "This will remove the worktree directory."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        alert.buttons[0].hasDestructiveAction = true

        let checkbox = NSButton(checkboxWithTitle: "Also delete branch \"\(worktree.branch)\"", target: nil, action: nil)
        checkbox.frame = CGRect(x: 0, y: 0, width: 300, height: 20)
        alert.accessoryView = checkbox

        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            guard let self = self, let pm = self.projectManager else { return }

            if let script = pm.projects[index].teardownScript, !script.isEmpty {
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

            pm.destroyWorktreeSessions(path: worktree.path, projectIndex: index)

            do {
                try GitHelper.deleteWorktree(
                    path: worktree.path,
                    repoURL: project.path
                )
            } catch {
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

            pm.refreshWorktrees(for: index)
            pm.persistProjects()
        }
    }

    func requestProjectSettings(at index: Int) {
        guard let pm = projectManager, index < pm.projects.count, let window else { return }
        let project = pm.projects[index]

        let vc = ProjectSettingsViewController(project: project) { [weak pm] updated in
            guard let pm else { return }
            pm.projects[index] = updated
            pm.persistProjects()
        }

        window.contentViewController?.presentAsSheet(vc)
    }

    func requestCheckoutDefaultBranch(inProject index: Int) {
        guard let pm = projectManager, index < pm.projects.count else { return }
        let project = pm.projects[index]
        let branch = project.defaultBranch

        do {
            let wtPath = try GitHelper.createWorktree(
                repoURL: project.path,
                branch: branch,
                isExisting: true
            )
            pm.refreshWorktrees(for: index)
            if let wtIdx = pm.projects[index].worktreeModels.firstIndex(where: { $0.info.path == wtPath }) {
                pm.selectWorktree(at: wtIdx, inProject: index)
            }
            pm.persistProjects()
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    func renameWorktree(_ worktree: WorktreeInfo, newName: String, inProject index: Int) {
        guard let pm = projectManager, index < pm.projects.count else { return }
        guard let wtIdx = pm.projects[index].worktreeModels.firstIndex(where: { $0.info.path == worktree.path }) else { return }
        pm.projects[index].worktreeModels[wtIdx].displayName = newName.isEmpty ? nil : newName
        pm.persistProjects()
    }

    func runWorktreeCommand(_ worktree: WorktreeInfo, inProject index: Int) {
        guard let pm = projectManager, index < pm.projects.count else { return }
        let project = pm.projects[index]

        let command: String?
        if let wtIdx = project.worktreeModels.firstIndex(where: { $0.info.path == worktree.path }) {
            command = project.worktreeModels[wtIdx].runCommand ?? project.defaultRunCommand
        } else {
            command = project.defaultRunCommand
        }

        guard let cmd = command, !cmd.isEmpty else { return }
        appState?.createNewTab(runningScript: cmd)
    }
}
