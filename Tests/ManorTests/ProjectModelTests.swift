import XCTest
@testable import ManorCore

final class ProjectModelTests: XCTestCase {

    // MARK: - worktreeIndex(matching:)

    /// A real worktree with a non-empty path is found by its path.
    func testWorktreeIndexReturnsCorrectIndexForRealWorktree() {
        let wt = WorktreeInfo(path: "/repos/myrepo", branch: "main", isMain: true)
        let project = makeProject(worktrees: [wt])

        XCTAssertEqual(project.worktreeIndex(matching: wt), 0)
    }

    /// A phantom sidebar item (path == "") never resolves to a worktree model —
    /// the caller should fall back to project-level selection instead.
    func testWorktreeIndexReturnsNilForPhantomItem() {
        let real = WorktreeInfo(path: "/repos/myrepo", branch: "main", isMain: true)
        let phantom = WorktreeInfo(path: "", branch: "main", isMain: true, isCheckedOut: false)
        let project = makeProject(worktrees: [real])

        XCTAssertNil(project.worktreeIndex(matching: phantom),
                     "Phantom items must not match any real worktree")
    }

    /// An unknown path (not in the project) returns nil.
    func testWorktreeIndexReturnsNilForUnknownPath() {
        let wt = WorktreeInfo(path: "/repos/myrepo", branch: "main", isMain: true)
        let unknown = WorktreeInfo(path: "/repos/other", branch: "feature", isMain: false)
        let project = makeProject(worktrees: [wt])

        XCTAssertNil(project.worktreeIndex(matching: unknown))
    }

    /// Multiple worktrees — the correct index is returned for each.
    func testWorktreeIndexWithMultipleWorktrees() {
        let wt0 = WorktreeInfo(path: "/repos/myrepo", branch: "main", isMain: true)
        let wt1 = WorktreeInfo(path: "/repos/worktrees/feature", branch: "feature", isMain: false)
        let wt2 = WorktreeInfo(path: "/repos/worktrees/bugfix", branch: "bugfix", isMain: false)
        let project = makeProject(worktrees: [wt0, wt1, wt2])

        XCTAssertEqual(project.worktreeIndex(matching: wt0), 0)
        XCTAssertEqual(project.worktreeIndex(matching: wt1), 1)
        XCTAssertEqual(project.worktreeIndex(matching: wt2), 2)
    }

    // MARK: - Helpers

    private func makeProject(worktrees: [WorktreeInfo]) -> ProjectModel {
        let models = worktrees.map { WorktreeModel(info: $0) }
        return ProjectModel(
            name: "TestRepo",
            path: URL(fileURLWithPath: "/repos/myrepo"),
            worktreeModels: models
        )
    }
}
