import XCTest
@testable import ManorCore

final class ProjectPersistenceTests: XCTestCase {

    // MARK: - PersistedState round-trip

    func testPersistedStateEncodeDecodRoundTrip() throws {
        let paneID = PaneID()
        let tab = TabModel(paneID: paneID, title: "Shell")
        let state = PersistedState(
            projects: [
                PersistedProject(
                    id: UUID(),
                    name: "MyRepo",
                    path: "/Users/user/projects/myrepo",
                    selectedWorktreeIndex: 0,
                    worktrees: [
                        PersistedWorktree(
                            path: "/Users/user/projects/myrepo",
                            tabs: [tab],
                            selectedTabIndex: 0,
                            displayName: nil,
                            runCommand: "npm start"
                        )
                    ],
                    defaultBranch: "main"
                )
            ],
            selectedProjectIndex: 0
        )

        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(PersistedState.self, from: data)

        XCTAssertEqual(decoded.projects.count, 1)
        XCTAssertEqual(decoded.selectedProjectIndex, 0)

        let project = decoded.projects[0]
        XCTAssertEqual(project.name, "MyRepo")
        XCTAssertEqual(project.path, "/Users/user/projects/myrepo")
        XCTAssertEqual(project.defaultBranch, "main")
        XCTAssertEqual(project.worktrees.count, 1)

        let worktree = project.worktrees[0]
        XCTAssertEqual(worktree.runCommand, "npm start")
        XCTAssertEqual(worktree.tabs.count, 1)
        XCTAssertEqual(worktree.tabs[0].title, "Shell")
    }

    func testPersistedStateWithMissingOptionalFieldsDecodesWithDefaults() throws {
        // Minimal JSON omitting optional fields
        let json = """
        {
            "projects": [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "name": "Minimal",
                    "path": "/some/path",
                    "selectedWorktreeIndex": 0,
                    "worktrees": []
                }
            ],
            "selectedProjectIndex": 0
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(PersistedState.self, from: json)

        XCTAssertEqual(decoded.projects.count, 1)
        XCTAssertEqual(decoded.projects[0].defaultBranch, "main", "defaultBranch should default to 'main'")
        XCTAssertNil(decoded.projects[0].setupScript)
        XCTAssertNil(decoded.projects[0].teardownScript)
        XCTAssertNil(decoded.projects[0].defaultRunCommand)
    }

    func testPersistedWorktreeWithMissingTabsDecodesAsEmpty() throws {
        let json = """
        {
            "path": "/some/path",
            "selectedTabIndex": 0
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(PersistedWorktree.self, from: json)

        XCTAssertTrue(decoded.tabs.isEmpty, "Missing tabs should decode as empty array")
        XCTAssertEqual(decoded.paneSessions.count, 0)
    }

    func testPersistencePreservesPaneIDs() throws {
        let paneID = PaneID()
        let tab = TabModel(paneID: paneID, title: "Terminal")

        let worktree = PersistedWorktree(
            path: "/path",
            tabs: [tab],
            selectedTabIndex: 0,
            paneSessions: [paneID.id.uuidString: PersistedPaneSession(lastCWD: "/Users/user/code")]
        )

        let data = try JSONEncoder().encode(worktree)
        let decoded = try JSONDecoder().decode(PersistedWorktree.self, from: data)

        XCTAssertEqual(decoded.paneSessions.count, 1)
        let session = decoded.paneSessions[paneID.id.uuidString]
        XCTAssertEqual(session?.lastCWD, "/Users/user/code")
    }

    func testPersistencePreservesScripts() throws {
        let project = PersistedProject(
            id: UUID(),
            name: "Test",
            path: "/path",
            selectedWorktreeIndex: 0,
            worktrees: [],
            defaultBranch: "develop",
            setupScript: "make setup",
            teardownScript: "make clean",
            defaultRunCommand: "make run"
        )

        let data = try JSONEncoder().encode(project)
        let decoded = try JSONDecoder().decode(PersistedProject.self, from: data)

        XCTAssertEqual(decoded.defaultBranch, "develop")
        XCTAssertEqual(decoded.setupScript, "make setup")
        XCTAssertEqual(decoded.teardownScript, "make clean")
        XCTAssertEqual(decoded.defaultRunCommand, "make run")
    }

    func testPersistedStateWithMultipleProjectsRoundTrips() throws {
        let state = PersistedState(
            projects: [
                PersistedProject(id: UUID(), name: "Alpha", path: "/alpha", selectedWorktreeIndex: 0, worktrees: []),
                PersistedProject(id: UUID(), name: "Beta", path: "/beta", selectedWorktreeIndex: 1, worktrees: []),
                PersistedProject(id: UUID(), name: "Gamma", path: "/gamma", selectedWorktreeIndex: 0, worktrees: []),
            ],
            selectedProjectIndex: 2
        )

        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(PersistedState.self, from: data)

        XCTAssertEqual(decoded.projects.count, 3)
        XCTAssertEqual(decoded.selectedProjectIndex, 2)
        XCTAssertEqual(decoded.projects.map(\.name), ["Alpha", "Beta", "Gamma"])
        XCTAssertEqual(decoded.projects[1].selectedWorktreeIndex, 1)
    }

    // MARK: - PaneNode Codable (via TabModel)

    func testTabModelWithNestedPaneTreeRoundTrips() throws {
        let a = PaneID()
        let b = PaneID()
        let c = PaneID()

        var tab = TabModel(paneID: a)
        tab.rootNode = PaneNode.split(
            direction: .horizontal,
            ratio: 0.6,
            first: .leaf(a),
            second: .split(direction: .vertical, ratio: 0.4, first: .leaf(b), second: .leaf(c))
        )
        tab.focusedPaneID = b

        let data = try JSONEncoder().encode(tab)
        let decoded = try JSONDecoder().decode(TabModel.self, from: data)

        XCTAssertEqual(decoded.rootNode.allPaneIDs.map(\.id), [a.id, b.id, c.id])
        XCTAssertEqual(decoded.focusedPaneID.id, b.id)
    }
}
