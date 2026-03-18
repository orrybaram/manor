import SwiftUI
import ManorCore

// MARK: - Worktree View Item

struct WorktreeViewItem {
    let info: WorktreeInfo
    let label: String
    let hasRunCommand: Bool
    var prInfo: GitHubPRInfo?
    var diffStat: DiffStat?
}

// MARK: - Legacy ViewModel type alias (for sidebarProjectEntries return type)

enum SidebarProjectsViewModel {
    typealias ProjectEntry = (id: UUID, name: String, worktrees: [WorktreeViewItem], selectedWorktreePath: String?)
}

// MARK: - View

struct SidebarProjectsView: View {
    @EnvironmentObject var appState: AppState

    @State private var expandedProjectIDs: Set<UUID> = []
    @State private var hoveredProjectIndex: Int? = nil
    @State private var hoveredWorktreePath: String? = nil
    @State private var renamingPath: String? = nil
    @State private var renameText: String = ""

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    private var projectEntries: [SidebarProjectsViewModel.ProjectEntry] {
        appState.sidebarProjectEntries()
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(projectEntries.enumerated()), id: \.element.id) { index, project in
                projectSection(project: project, index: index)
            }
        }
        .onChange(of: appState.projects.count) { _ in
            autoExpandSelectedProject()
        }
        .onAppear {
            autoExpandSelectedProject()
        }
    }

    private func autoExpandSelectedProject() {
        for project in appState.projects {
            if appState.projects.firstIndex(where: { $0.id == project.id }) == appState.selectedProjectIndex {
                expandedProjectIDs.insert(project.id)
            }
        }
    }

    // MARK: - Project Section

    @ViewBuilder
    private func projectSection(project: SidebarProjectsViewModel.ProjectEntry, index: Int) -> some View {
        projectHeaderRow(project: project, index: index)

        if expandedProjectIDs.contains(project.id) {
            let sorted = project.worktrees.sorted { $0.info.isMain && !$1.info.isMain }
            let showWorktreeSelection = index == appState.selectedProjectIndex && project.worktrees.count > 1

            ForEach(sorted, id: \.info.path) { item in
                worktreeRow(
                    item: item,
                    projectIndex: index,
                    selectedPath: showWorktreeSelection ? project.selectedWorktreePath : nil
                )
            }
        }
    }

    // MARK: - Project Header Row

    private func projectHeaderRow(project: SidebarProjectsViewModel.ProjectEntry, index: Int) -> some View {
        let isSelected = index == appState.selectedProjectIndex
        let isExpanded = expandedProjectIDs.contains(project.id)
        let isHovered = hoveredProjectIndex == index
        let hasWorktrees = !project.worktrees.isEmpty

        return ZStack(alignment: .leading) {
            if isSelected {
                Color(nsColor: theme.selectedBackground)
            } else if isHovered {
                Color(nsColor: theme.hoverBackground)
            }

            HStack(spacing: 0) {
                if hasWorktrees {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(Color(nsColor: isSelected ? theme.selectedText : theme.dimText))
                        .frame(width: 16)
                        .padding(.leading, 12)
                } else {
                    Spacer().frame(width: 28)
                }

                Text(project.name)
                    .font(.system(size: 12, weight: isSelected ? .medium : .regular))
                    .foregroundColor(Color(nsColor: isSelected ? theme.selectedText : theme.primaryText))
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 4)

                if isHovered {
                    Button {
                        appState.requestCreateWorktree(inProject: index)
                    } label: {
                        Text("+")
                            .font(.system(size: 13, weight: .light))
                            .foregroundColor(Color(nsColor: theme.dimText))
                            .frame(width: 22, height: 26)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(height: 26)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering {
                hoveredProjectIndex = index
            } else if hoveredProjectIndex == index {
                hoveredProjectIndex = nil
            }
        }
        .onTapGesture {
            if hasWorktrees {
                if expandedProjectIDs.contains(project.id) {
                    expandedProjectIDs.remove(project.id)
                } else {
                    expandedProjectIDs.insert(project.id)
                }
            }
            appState.selectProject(at: index)
        }
        .contextMenu {
            Button("New Worktree") { appState.requestCreateWorktree(inProject: index) }
            Divider()
            Button("Project Settings…") { appState.requestProjectSettings(at: index) }
            Divider()
            Button("Remove Project") { appState.removeProject(at: index) }
        }
    }

    // MARK: - Worktree Row

    private func worktreeRow(item: WorktreeViewItem, projectIndex: Int, selectedPath: String?) -> some View {
        let isCheckedOut = item.info.isCheckedOut || item.info.isMain
        let isItemSelected = !item.info.path.isEmpty && item.info.path == selectedPath
        let isHovered = hoveredWorktreePath == item.info.path
        let isRenaming = renamingPath == item.info.path
        let itemPath = item.info.path

        let iconColor = Color(nsColor: !isCheckedOut
            ? theme.dimText.withAlphaComponent(0.5)
            : isItemSelected ? theme.selectedText : theme.dimText)
        let labelColor = Color(nsColor: !isCheckedOut
            ? theme.dimText.withAlphaComponent(0.5)
            : isItemSelected ? theme.selectedText : theme.primaryText)

        return ZStack(alignment: .leading) {
            if isItemSelected {
                Color(nsColor: theme.selectedBackground)
            } else if isHovered {
                Color(nsColor: theme.hoverBackground)
            }

            HStack(spacing: 0) {
                Text("\u{2387}")
                    .font(.system(size: 10))
                    .foregroundColor(iconColor)
                    .frame(width: 16)
                    .padding(.leading, 16)

                if isRenaming {
                    TextField("", text: $renameText)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11))
                        .foregroundColor(Color(nsColor: theme.primaryText))
                        .padding(.trailing, 4)
                        .onSubmit { commitRename(item: item, projectIndex: projectIndex) }
                } else {
                    Text(item.label)
                        .font(.system(size: 11, weight: !isCheckedOut ? .light : isItemSelected ? .medium : .regular))
                        .foregroundColor(labelColor)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer(minLength: 4)

                if let stat = item.diffStat, !isRenaming {
                    HStack(spacing: 2) {
                        Text("+\(stat.additions)")
                            .font(.system(size: 10).monospacedDigit())
                            .foregroundColor(Color(red: 0.3, green: 0.8, blue: 0.4))
                        Text("-\(stat.deletions)")
                            .font(.system(size: 10).monospacedDigit())
                            .foregroundColor(Color(red: 0.9, green: 0.35, blue: 0.35))
                    }
                    .padding(.trailing, 6)
                } else if isHovered && !isRenaming {
                    if isCheckedOut && item.hasRunCommand {
                        Button {
                            appState.runWorktreeCommand(item.info, inProject: projectIndex)
                        } label: {
                            Text("▶")
                                .font(.system(size: 10))
                                .foregroundColor(Color(nsColor: theme.dimText))
                                .frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain)
                    } else if !isCheckedOut {
                        Button {
                            appState.requestCheckoutDefaultBranch(inProject: projectIndex)
                        } label: {
                            Text("co")
                                .font(.system(size: 9))
                                .foregroundColor(Color(nsColor: theme.dimText))
                                .frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(height: 22)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering {
                hoveredWorktreePath = itemPath
            } else if hoveredWorktreePath == itemPath {
                hoveredWorktreePath = nil
            }
        }
        .onTapGesture {
            guard !isRenaming else { return }
            if isCheckedOut {
                appState.selectWorktreeFromSidebar(item.info, inProject: projectIndex)
            } else {
                appState.requestCheckoutDefaultBranch(inProject: projectIndex)
            }
        }
        .contextMenu {
            if isCheckedOut && !item.info.isMain {
                Button("Rename…") {
                    renamingPath = itemPath
                    renameText = item.label
                }
                Divider()
            }
            Button("Delete Worktree…") {
                appState.requestDeleteWorktree(item.info, inProject: projectIndex)
            }
            .disabled(item.info.isMain)
        }
    }

    // MARK: - Rename

    private func commitRename(item: WorktreeViewItem, projectIndex: Int) {
        let newName = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        let savedItem = item
        cancelRename()
        if !newName.isEmpty && newName != savedItem.label {
            appState.renameWorktree(savedItem.info, newName: newName, inProject: projectIndex)
        }
    }

    private func cancelRename() {
        renamingPath = nil
        renameText = ""
    }
}
