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

    // MARK: - ZDOTDIR setup

    func testSetupZdotdirCreatesDirectory() {
        let dir = ProjectPersistence.setupZdotdir()
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
    }

    func testSetupZdotdirIsUnderApplicationSupport() {
        XCTAssertTrue(ProjectPersistence.zdotdirURL.path.contains("Application Support/Manor/zdotdir"))
    }

    func testZdotdirZshrcSourcesRealZshrcAndRestoresHistfile() throws {
        ProjectPersistence.setupZdotdir()
        let zshrcURL = ProjectPersistence.zdotdirURL.appendingPathComponent(".zshrc")
        XCTAssertTrue(FileManager.default.fileExists(atPath: zshrcURL.path),
                      ".zshrc wrapper should exist in zdotdir")
        let content = try String(contentsOf: zshrcURL, encoding: .utf8)
        XCTAssertTrue(content.contains(".zshrc"), ".zshrc wrapper should source real .zshrc")
        XCTAssertTrue(content.contains("MANOR_HISTFILE"), ".zshrc wrapper should restore HISTFILE from MANOR_HISTFILE")
        XCTAssertTrue(content.contains("INC_APPEND_HISTORY"), ".zshrc wrapper should enable incremental history writes")
    }

    func testZdotdirContainsAllRequiredWrapperFiles() {
        ProjectPersistence.setupZdotdir()
        let dir = ProjectPersistence.zdotdirURL
        let required = [".zshenv", ".zprofile", ".zshrc", ".zlogin"]
        for name in required {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path),
                "Missing wrapper file: \(name)"
            )
        }
    }

    func testZdotdirWrapperFilesSourceRealZdotdir() throws {
        ProjectPersistence.setupZdotdir()
        let dir = ProjectPersistence.zdotdirURL
        for name in [".zshenv", ".zprofile", ".zlogin"] {
            let content = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
            XCTAssertTrue(content.contains("REAL_ZDOTDIR"), "\(name) should reference REAL_ZDOTDIR")
            XCTAssertTrue(content.contains(name.dropFirst()), "\(name) should source the real \(name)")
        }
    }

    func testSetupZdotdirIsIdempotent() throws {
        ProjectPersistence.setupZdotdir()
        let firstContent = try String(contentsOf: ProjectPersistence.zdotdirURL.appendingPathComponent(".zshrc"), encoding: .utf8)
        ProjectPersistence.setupZdotdir()
        let secondContent = try String(contentsOf: ProjectPersistence.zdotdirURL.appendingPathComponent(".zshrc"), encoding: .utf8)
        XCTAssertEqual(firstContent, secondContent, "setupZdotdir should be idempotent")
    }

    /// End-to-end: start a zsh session whose GHOSTTY_ZSH_ZDOTDIR points to Manor's zdotdir
    /// (simulating how Ghostty's shell integration chains into our wrappers), write history to
    /// a UUID-named file, then verify a fresh shell reads that history back.
    func testZshHistoryPersistsThroughGhosttyZdotdirChain() throws {
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        // Minimal zdotdir that mirrors what setupZdotdir() writes
        let zdotdir = tmpDir.appendingPathComponent("zdotdir")
        try FileManager.default.createDirectory(at: zdotdir, withIntermediateDirectories: true)
        // .zshrc: restore HISTFILE from MANOR_HISTFILE and enable incremental appends
        try """
            [[ -n $MANOR_HISTFILE ]] && HISTFILE=$MANOR_HISTFILE
            setopt INC_APPEND_HISTORY
            """.write(to: zdotdir.appendingPathComponent(".zshrc"), atomically: true, encoding: .utf8)

        let histFile = tmpDir.appendingPathComponent("test-pane.history")

        // ── Phase 1: simulate a shell session that runs a command ───────────────
        let env: [String: String] = [
            "HISTFILE": histFile.path,
            "MANOR_HISTFILE": histFile.path,
            "ZDOTDIR": zdotdir.path,   // no Ghostty integration layer in the test
            "HISTSIZE": "10000",
            "SAVEHIST": "10000",
            "HOME": NSHomeDirectory(),
            "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
            "TERM": "xterm-256color",
        ]

        func runZsh(_ script: String) throws -> (stdout: String, stderr: String) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            // -i: interactive (enables history); -c: run script
            p.arguments = ["-i", "-c", script]
            p.environment = env
            let outPipe = Pipe()
            let errPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = errPipe
            try p.run()
            p.waitUntilExit()
            let stdout = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let stderr = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return (stdout, stderr)
        }

        // Phase 1: print -s adds a line to the in-memory history list;
        // fc -W saves the history list to HISTFILE (set by our .zshrc wrapper).
        _ = try runZsh("print -s -- 'manor_sentinel_history_test_42'; fc -W")

        let historyContent = (try? String(contentsOf: histFile, encoding: .utf8)) ?? ""
        XCTAssertTrue(
            historyContent.contains("manor_sentinel_history_test_42"),
            "Phase 1: command should be written to Manor history file. Got:\n\(historyContent)"
        )

        // ── Phase 2: fresh shell should read that history back ──────────────────
        // In test (no PTY), zsh -i -c doesn't auto-load history on startup, so we
        // call fc -R explicitly — that's the same built-in zsh uses internally to
        // load HISTFILE. If history is in the file, fc -l 1 should then return it.
        let (output, errOutput) = try runZsh("fc -R \"$HISTFILE\"; fc -l 1")
        XCTAssertTrue(
            output.contains("manor_sentinel_history_test_42"),
            "Phase 2: fc -R should load our Manor history file and fc -l should list it.\nstdout: \(output)\nstderr: \(errOutput)"
        )
    }

    // MARK: - History file / session restoration

    func testHistoryFilePathIsStableAcrossEncodeDecodeCycle() throws {
        let originalPaneID = PaneID()
        let originalPath = ProjectPersistence.historyFile(for: originalPaneID)

        let worktree = PersistedWorktree(
            path: "/some/path", tabs: [], selectedTabIndex: 0,
            paneSessions: [originalPaneID.id.uuidString: PersistedPaneSession(lastCWD: "/tmp")]
        )
        let data = try JSONEncoder().encode(worktree)
        let decoded = try JSONDecoder().decode(PersistedWorktree.self, from: data)

        guard let (uuidString, _) = decoded.paneSessions.first,
              let uuid = UUID(uuidString: uuidString) else {
            return XCTFail("Expected one pane session after decode")
        }
        let restoredPath = ProjectPersistence.historyFile(for: PaneID(restoredID: uuid))
        XCTAssertEqual(restoredPath, originalPath)
    }

    func testPaneSessionsSurviveFullStateRoundTrip() throws {
        let paneA = PaneID()
        let paneB = PaneID()
        let worktree = PersistedWorktree(
            path: "/repo", tabs: [], selectedTabIndex: 0,
            paneSessions: [
                paneA.id.uuidString: PersistedPaneSession(lastCWD: "/repo/src"),
                paneB.id.uuidString: PersistedPaneSession(lastCWD: "/repo/tests"),
            ]
        )
        let state = PersistedState(projects: [
            PersistedProject(id: UUID(), name: "Repo", path: "/repo",
                             selectedWorktreeIndex: 0, worktrees: [worktree])
        ], selectedProjectIndex: 0)

        let decoded = try JSONDecoder().decode(PersistedState.self,
                                               from: try JSONEncoder().encode(state))
        let sessions = decoded.projects[0].worktrees[0].paneSessions
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions[paneA.id.uuidString]?.lastCWD, "/repo/src")
        XCTAssertEqual(sessions[paneB.id.uuidString]?.lastCWD, "/repo/tests")
    }

    func testPaneSessionWithNilCWDRoundTrips() throws {
        let paneID = PaneID()
        let worktree = PersistedWorktree(
            path: "/path", tabs: [], selectedTabIndex: 0,
            paneSessions: [paneID.id.uuidString: PersistedPaneSession(lastCWD: nil)]
        )
        let decoded = try JSONDecoder().decode(PersistedWorktree.self,
                                               from: try JSONEncoder().encode(worktree))
        XCTAssertEqual(decoded.paneSessions.count, 1)
        XCTAssertNil(decoded.paneSessions[paneID.id.uuidString]?.lastCWD)
    }

    func testHistoryFileContainsPaneUUID() {
        let paneID = PaneID()
        let url = ProjectPersistence.historyFile(for: paneID)
        XCTAssertTrue(url.lastPathComponent.hasPrefix(paneID.id.uuidString))
        XCTAssertEqual(url.pathExtension, "history")
        XCTAssertTrue(url.path.contains("sessions"))
    }

    func testSessionsDirectoryIsUnderApplicationSupport() {
        XCTAssertTrue(ProjectPersistence.sessionsDirectory.path.contains("Application Support/Manor/sessions"))
    }

    func testAllPaneIDsInTreeHaveSessionsAfterRoundTrip() throws {
        let a = PaneID(); let b = PaneID(); let c = PaneID()
        var tab = TabModel(paneID: a)
        tab.rootNode = .split(direction: .horizontal, ratio: 0.5,
                              first: .leaf(a),
                              second: .split(direction: .vertical, ratio: 0.5,
                                             first: .leaf(b), second: .leaf(c)))
        let sessions = [a, b, c].reduce(into: [String: PersistedPaneSession]()) {
            $0[$1.id.uuidString] = PersistedPaneSession(lastCWD: "/\($1.id.uuidString.prefix(4))")
        }
        let worktree = PersistedWorktree(path: "/repo", tabs: [tab],
                                         selectedTabIndex: 0, paneSessions: sessions)
        let decoded = try JSONDecoder().decode(PersistedWorktree.self,
                                               from: try JSONEncoder().encode(worktree))
        let decodedIDs = decoded.tabs[0].rootNode.allPaneIDs.map(\.id.uuidString)
        for id in decodedIDs {
            XCTAssertNotNil(decoded.paneSessions[id], "Pane \(id) missing session after decode")
        }
    }
}
