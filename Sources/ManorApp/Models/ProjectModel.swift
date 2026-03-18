import Foundation

// MARK: - Project Settings

struct ProjectSettings: Codable, Equatable {
    /// Directory where git worktrees will be created for this project.
    var worktreeDirectory: String = ""

    /// Shell script executed after a worktree is created (e.g., `npm install`).
    var setupScript: String = ""

    /// Shell script executed before a worktree is deleted (e.g., cleanup steps).
    var teardownScript: String = ""
}

// MARK: - Project Model

struct ProjectModel: Identifiable, Codable {
    let id: UUID
    var name: String
    /// Absolute path to the git repository root.
    var repositoryPath: String
    var settings: ProjectSettings

    init(name: String, repositoryPath: String = "") {
        self.id = UUID()
        self.name = name
        self.repositoryPath = repositoryPath
        self.settings = ProjectSettings()
    }
}

// MARK: - Project Store

/// Persists a list of projects to ~/Library/Application Support/Manor/projects.json.
final class ProjectStore {
    static let shared = ProjectStore()

    private let storeURL: URL

    private(set) var projects: [ProjectModel] = [] {
        didSet { save() }
    }

    private init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = appSupport.appendingPathComponent("Manor", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        storeURL = dir.appendingPathComponent("projects.json")
        load()
    }

    func upsert(_ project: ProjectModel) {
        if let idx = projects.firstIndex(where: { $0.id == project.id }) {
            projects[idx] = project
        } else {
            projects.append(project)
        }
    }

    func delete(_ id: UUID) {
        projects.removeAll { $0.id == id }
    }

    // MARK: Persistence

    private func load() {
        guard let data = try? Data(contentsOf: storeURL) else { return }
        if let decoded = try? JSONDecoder().decode([ProjectModel].self, from: data) {
            projects = decoded
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(projects) {
            try? data.write(to: storeURL, options: .atomic)
        }
    }
}
