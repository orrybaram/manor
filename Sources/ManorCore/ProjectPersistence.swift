import Foundation

// MARK: - Persisted Types

package struct PersistedPaneSession: Codable {
    package var lastCWD: String?

    package init(lastCWD: String? = nil) {
        self.lastCWD = lastCWD
    }
}

package struct PersistedWorktree: Codable {
    package let path: String
    package let tabs: [TabModel]
    package let selectedTabIndex: Int
    package let displayName: String?
    package let runCommand: String?
    package var paneSessions: [String: PersistedPaneSession]

    enum CodingKeys: String, CodingKey {
        case path, tabs, selectedTabIndex, displayName, runCommand, paneSessions
    }

    package init(path: String, tabs: [TabModel], selectedTabIndex: Int, displayName: String? = nil, runCommand: String? = nil, paneSessions: [String: PersistedPaneSession] = [:]) {
        self.path = path
        self.tabs = tabs
        self.selectedTabIndex = selectedTabIndex
        self.displayName = displayName
        self.runCommand = runCommand
        self.paneSessions = paneSessions
    }

    package init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        tabs = try container.decodeIfPresent([TabModel].self, forKey: .tabs) ?? []
        selectedTabIndex = try container.decodeIfPresent(Int.self, forKey: .selectedTabIndex) ?? 0
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName)
        runCommand = try container.decodeIfPresent(String.self, forKey: .runCommand)
        paneSessions = try container.decodeIfPresent([String: PersistedPaneSession].self, forKey: .paneSessions) ?? [:]
    }
}

package struct PersistedProject: Codable {
    package let id: UUID
    package let name: String
    package let path: String
    package var selectedWorktreeIndex: Int
    package var worktrees: [PersistedWorktree]
    package var defaultBranch: String
    package var setupScript: String?
    package var teardownScript: String?
    package var defaultRunCommand: String?

    enum CodingKeys: String, CodingKey {
        case id, name, path, selectedWorktreeIndex, worktrees
        case defaultBranch, setupScript, teardownScript, defaultRunCommand
    }

    package init(
        id: UUID,
        name: String,
        path: String,
        selectedWorktreeIndex: Int,
        worktrees: [PersistedWorktree],
        defaultBranch: String = "main",
        setupScript: String? = nil,
        teardownScript: String? = nil,
        defaultRunCommand: String? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.selectedWorktreeIndex = selectedWorktreeIndex
        self.worktrees = worktrees
        self.defaultBranch = defaultBranch
        self.setupScript = setupScript
        self.teardownScript = teardownScript
        self.defaultRunCommand = defaultRunCommand
    }

    package init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        path = try container.decode(String.self, forKey: .path)
        selectedWorktreeIndex = try container.decodeIfPresent(Int.self, forKey: .selectedWorktreeIndex) ?? 0
        worktrees = try container.decodeIfPresent([PersistedWorktree].self, forKey: .worktrees) ?? []
        defaultBranch = try container.decodeIfPresent(String.self, forKey: .defaultBranch) ?? "main"
        setupScript = try container.decodeIfPresent(String.self, forKey: .setupScript)
        teardownScript = try container.decodeIfPresent(String.self, forKey: .teardownScript)
        defaultRunCommand = try container.decodeIfPresent(String.self, forKey: .defaultRunCommand)
    }
}

package struct PersistedState: Codable {
    package var projects: [PersistedProject]
    package var selectedProjectIndex: Int

    package init(projects: [PersistedProject], selectedProjectIndex: Int) {
        self.projects = projects
        self.selectedProjectIndex = selectedProjectIndex
    }
}

// MARK: - Project Persistence

package enum ProjectPersistence {
    private static let fileURL: URL = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("Manor/projects.json")
    }()

    package static let sessionsDirectory: URL = {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Manor/sessions")
    }()

    package static let zdotdirURL: URL = {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Manor/zdotdir")
    }()

    package static func historyFile(for paneID: PaneID) -> URL {
        sessionsDirectory.appendingPathComponent("\(paneID.id.uuidString).history")
    }

    /// Creates a ZDOTDIR with wrapper dotfiles so that Manor can inject HISTFILE
    /// after the user's real .zshrc runs (which commonly overrides HISTFILE).
    /// Each wrapper sources the real dotfile from REAL_ZDOTDIR (defaults to $HOME),
    /// then the .zshrc wrapper resets HISTFILE from $MANOR_HISTFILE and enables
    /// incremental history writes (INC_APPEND_HISTORY).
    @discardableResult
    package static func setupZdotdir() -> URL {
        let dir = zdotdirURL
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let files: [(name: String, body: String)] = [
            (".zshenv",   "[[ -f \"${REAL_ZDOTDIR:-$HOME}/.zshenv\" ]] && source \"${REAL_ZDOTDIR:-$HOME}/.zshenv\"\n"),
            (".zprofile", "[[ -f \"${REAL_ZDOTDIR:-$HOME}/.zprofile\" ]] && source \"${REAL_ZDOTDIR:-$HOME}/.zprofile\"\n"),
            (".zshrc",    """
                          [[ -f "${REAL_ZDOTDIR:-$HOME}/.zshrc" ]] && source "${REAL_ZDOTDIR:-$HOME}/.zshrc"
                          [[ -n $MANOR_HISTFILE ]] && HISTFILE=$MANOR_HISTFILE
                          setopt INC_APPEND_HISTORY
                          """),
            (".zlogin",   "[[ -f \"${REAL_ZDOTDIR:-$HOME}/.zlogin\" ]] && source \"${REAL_ZDOTDIR:-$HOME}/.zlogin\"\n"),
        ]

        for (name, body) in files {
            try? body.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        return dir
    }

    package static func save(_ state: PersistedState) {
        let fileManager = FileManager.default
        let dir = fileURL.deletingLastPathComponent()

        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        guard let data = try? encoder.encode(state) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    package static func load() -> PersistedState? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(PersistedState.self, from: data)
    }

    // MARK: - Convenience

    package static func persist(projects: [ProjectModel], selectedIndex: Int, paneCWD: [PaneID: String] = [:]) {
        let persisted = projects.map { project in
            let persistedWorktrees = project.worktreeModels.map { wt in
                var sessions: [String: PersistedPaneSession] = [:]
                for tab in wt.tabs {
                    for paneID in tab.rootNode.allPaneIDs {
                        if let cwd = paneCWD[paneID] {
                            sessions[paneID.id.uuidString] = PersistedPaneSession(lastCWD: cwd)
                        }
                    }
                }
                return PersistedWorktree(
                    path: wt.info.path,
                    tabs: wt.tabs,
                    selectedTabIndex: wt.selectedTabIndex,
                    displayName: wt.displayName,
                    runCommand: wt.runCommand,
                    paneSessions: sessions
                )
            }
            return PersistedProject(
                id: project.id,
                name: project.name,
                path: project.path.path,
                selectedWorktreeIndex: project.selectedWorktreeIndex,
                worktrees: persistedWorktrees,
                defaultBranch: project.defaultBranch,
                setupScript: project.setupScript,
                teardownScript: project.teardownScript,
                defaultRunCommand: project.defaultRunCommand
            )
        }
        let state = PersistedState(projects: persisted, selectedProjectIndex: selectedIndex)
        save(state)
    }

    package static func restore() -> (projects: [ProjectModel], paneCWD: [PaneID: String]) {
        guard let state = load() else { return ([], [:]) }
        let fileManager = FileManager.default
        var paneCWD: [PaneID: String] = [:]

        let projects: [ProjectModel] = state.projects.compactMap { persisted in
            let url = URL(fileURLWithPath: persisted.path)
            guard fileManager.fileExists(atPath: persisted.path) else { return nil }

            let gitWorktrees = GitHelper.listWorktrees(at: url)

            // Build lookup from worktree path -> persisted data
            let persistedByPath: [String: PersistedWorktree] = Dictionary(
                uniqueKeysWithValues: persisted.worktrees.map { ($0.path, $0) }
            )

            let worktreeModels: [WorktreeModel]
            if gitWorktrees.isEmpty {
                let defaultInfo = WorktreeInfo(path: url.path, branch: persisted.name, isMain: true)
                let saved = persistedByPath[url.path]
                worktreeModels = [WorktreeModel(
                    info: defaultInfo,
                    tabs: saved?.tabs ?? [],
                    selectedTabIndex: saved?.selectedTabIndex ?? 0,
                    displayName: saved?.displayName,
                    runCommand: saved?.runCommand
                )]
            } else {
                worktreeModels = gitWorktrees.map { gitWt in
                    let saved = persistedByPath[gitWt.path]
                    return WorktreeModel(
                        info: gitWt,
                        tabs: saved?.tabs ?? [],
                        selectedTabIndex: saved?.selectedTabIndex ?? 0,
                        displayName: saved?.displayName,
                        runCommand: saved?.runCommand
                    )
                }
            }

            // Rebuild paneCWD from persisted sessions
            for savedWt in persisted.worktrees {
                for (uuidString, session) in savedWt.paneSessions {
                    guard let cwd = session.lastCWD,
                          let uuid = UUID(uuidString: uuidString) else { continue }
                    let paneID = PaneID(restoredID: uuid)
                    paneCWD[paneID] = cwd
                }
            }

            let selectedWorktreeIndex = min(
                persisted.selectedWorktreeIndex,
                max(0, worktreeModels.count - 1)
            )

            return ProjectModel(
                id: persisted.id,
                name: persisted.name,
                path: url,
                worktreeModels: worktreeModels,
                selectedWorktreeIndex: selectedWorktreeIndex,
                defaultBranch: persisted.defaultBranch,
                setupScript: persisted.setupScript,
                teardownScript: persisted.teardownScript,
                defaultRunCommand: persisted.defaultRunCommand
            )
        }

        return (projects, paneCWD)
    }
}
