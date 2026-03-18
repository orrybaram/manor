import Foundation

// MARK: - Worktree Info

package struct WorktreeInfo: Hashable {
    package let path: String
    package let branch: String
    package let isMain: Bool
    package var isCheckedOut: Bool

    package init(path: String, branch: String, isMain: Bool, isCheckedOut: Bool = true) {
        self.path = path
        self.branch = branch
        self.isMain = isMain
        self.isCheckedOut = isCheckedOut
    }
}

// MARK: - Worktree Model

package struct WorktreeModel {
    package let id: UUID
    package var info: WorktreeInfo
    package var tabs: [TabModel]
    package var selectedTabIndex: Int
    package var displayName: String?
    package var runCommand: String?

    // GitHub data — not persisted, fetched on launch/refresh
    package var prInfo: GitHubPRInfo?
    package var diffStat: DiffStat?

    package var label: String { displayName ?? info.branch }

    package init(
        id: UUID = UUID(),
        info: WorktreeInfo,
        tabs: [TabModel] = [],
        selectedTabIndex: Int = 0,
        displayName: String? = nil,
        runCommand: String? = nil
    ) {
        self.id = id
        self.info = info
        self.tabs = tabs
        self.selectedTabIndex = selectedTabIndex
        self.displayName = displayName
        self.runCommand = runCommand
    }
}

// MARK: - Project Model

package struct ProjectModel {
    package let id: UUID
    package var name: String
    package var path: URL
    package var worktreeModels: [WorktreeModel]
    package var selectedWorktreeIndex: Int
    package var defaultBranch: String
    package var setupScript: String?
    package var teardownScript: String?
    package var defaultRunCommand: String?

    // Forward tabs/selectedTabIndex to the selected worktree
    package var tabs: [TabModel] {
        get {
            guard selectedWorktreeIndex < worktreeModels.count else { return [] }
            return worktreeModels[selectedWorktreeIndex].tabs
        }
        set {
            guard selectedWorktreeIndex < worktreeModels.count else { return }
            worktreeModels[selectedWorktreeIndex].tabs = newValue
        }
    }
    package var selectedTabIndex: Int {
        get {
            guard selectedWorktreeIndex < worktreeModels.count else { return 0 }
            return worktreeModels[selectedWorktreeIndex].selectedTabIndex
        }
        set {
            guard selectedWorktreeIndex < worktreeModels.count else { return }
            worktreeModels[selectedWorktreeIndex].selectedTabIndex = newValue
        }
    }

    package var worktrees: [WorktreeInfo] {
        worktreeModels.map { $0.info }
    }

    /// Returns the index of the worktree matching `info.path`, or nil if not found.
    /// Phantom sidebar items (path == "") always return nil — they represent a branch
    /// that isn't checked out and have no backing worktree model.
    package func worktreeIndex(matching info: WorktreeInfo) -> Int? {
        guard !info.path.isEmpty else { return nil }
        return worktreeModels.firstIndex(where: { $0.info.path == info.path })
    }

    package init(
        id: UUID = UUID(),
        name: String,
        path: URL,
        worktreeModels: [WorktreeModel],
        selectedWorktreeIndex: Int = 0,
        defaultBranch: String = "main",
        setupScript: String? = nil,
        teardownScript: String? = nil,
        defaultRunCommand: String? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.worktreeModels = worktreeModels
        self.selectedWorktreeIndex = selectedWorktreeIndex
        self.defaultBranch = defaultBranch
        self.setupScript = setupScript
        self.teardownScript = teardownScript
        self.defaultRunCommand = defaultRunCommand
    }
}

// MARK: - Git Helper

package enum GitHelper {
    package static func isGitRepo(at url: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["rev-parse", "--is-inside-work-tree"]
        process.currentDirectoryURL = url
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    package static func listWorktrees(at url: URL) -> [WorktreeInfo] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["worktree", "list", "--porcelain"]
        process.currentDirectoryURL = url

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return []
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [] }

        return parseWorktreePorcelain(output)
    }

    package static func repoName(at url: URL) -> String {
        url.lastPathComponent
    }

    /// Detects the default branch for a repo (main, master, etc.)
    package static func defaultBranch(at url: URL) -> String {
        // Try: git symbolic-ref --short refs/remotes/origin/HEAD
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]
        process.currentDirectoryURL = url
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let output = String(data: data, encoding: .utf8) {
                    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
                    // "origin/main" -> "main"
                    if let slash = trimmed.firstIndex(of: "/") {
                        return String(trimmed[trimmed.index(after: slash)...])
                    }
                    if !trimmed.isEmpty { return trimmed }
                }
            }
        } catch {}

        // Fall back: check if main or master exists locally
        for branch in ["main", "master"] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["rev-parse", "--verify", branch]
            p.currentDirectoryURL = url
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            if p.terminationStatus == 0 { return branch }
        }

        return "main"
    }

    /// Returns remote branch names (stripped of remote prefix, e.g. "feature/foo")
    package static func remoteBranches(at url: URL) -> [String] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["branch", "-r", "--format=%(refname:short)"]
        process.currentDirectoryURL = url
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch { return [] }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [] }

        return output.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasSuffix("/HEAD") }
            .map { ref -> String in
                // Strip "origin/" prefix
                if let slash = ref.firstIndex(of: "/") {
                    return String(ref[ref.index(after: slash)...])
                }
                return ref
            }
    }

    /// Creates a new worktree. Path is derived as ~/.manor/worktrees/<project>/<branch>.
    @discardableResult
    package static func createWorktree(
        repoURL: URL,
        branch: String,
        base: String = "HEAD",
        isExisting: Bool = false
    ) throws -> String {
        let safeName = branch.replacingOccurrences(of: "/", with: "-")
        let projectName = repoURL.lastPathComponent
        let worktreesBase = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".manor/worktrees")
            .appendingPathComponent(projectName)
        try FileManager.default.createDirectory(at: worktreesBase, withIntermediateDirectories: true)
        let worktreePath = worktreesBase.appendingPathComponent(safeName).path

        let args: [String] = isExisting
            ? ["worktree", "add", worktreePath, branch]
            : ["worktree", "add", "-b", branch, worktreePath, base]
        try runGit(arguments: args, at: repoURL)

        return worktreePath
    }

    /// Removes a worktree directory.
    package static func deleteWorktree(path: String, repoURL: URL, force: Bool = false) throws {
        let args: [String] = force
            ? ["worktree", "remove", "--force", path]
            : ["worktree", "remove", path]
        try runGit(arguments: args, at: repoURL)
    }

    /// Deletes a local branch.
    package static func deleteBranch(_ branch: String, at repoURL: URL, force: Bool = false) throws {
        try runGit(arguments: ["branch", force ? "-D" : "-d", branch], at: repoURL)
    }

    // MARK: - Internal

    static func parseWorktreePorcelain(_ output: String) -> [WorktreeInfo] {
        var worktrees: [WorktreeInfo] = []
        var currentPath: String?
        var currentBranch: String?
        var currentIsDetached = false
        var currentIsBare = false

        func flush() {
            guard let path = currentPath else { return }
            let branch = currentBranch ?? "HEAD"
            worktrees.append(WorktreeInfo(
                path: path,
                branch: branch,
                isMain: worktrees.isEmpty,
                isCheckedOut: !currentIsDetached && !currentIsBare
            ))
        }

        for line in output.components(separatedBy: "\n") {
            if line.hasPrefix("worktree ") {
                flush()
                currentPath = String(line.dropFirst("worktree ".count))
                currentBranch = nil
                currentIsDetached = false
                currentIsBare = false
            } else if line.hasPrefix("branch ") {
                let fullRef = String(line.dropFirst("branch ".count))
                if fullRef.hasPrefix("refs/heads/") {
                    currentBranch = String(fullRef.dropFirst("refs/heads/".count))
                } else {
                    currentBranch = fullRef
                }
            } else if line == "detached" {
                currentIsDetached = true
            } else if line == "bare" {
                currentIsBare = true
            } else if line.isEmpty {
                flush()
                currentPath = nil
                currentBranch = nil
                currentIsDetached = false
                currentIsBare = false
            }
        }

        flush() // flush last entry if output doesn't end with blank line

        return worktrees
    }

    // MARK: - Private

    /// Runs a git command, throwing an NSError if it exits non-zero.
    private static func runGit(arguments: [String], at url: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = url
        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "Unknown error"
            throw NSError(domain: "GitHelper", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: msg.trimmingCharacters(in: .whitespacesAndNewlines)])
        }
    }
}
