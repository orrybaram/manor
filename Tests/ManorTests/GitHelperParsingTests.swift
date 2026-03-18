import XCTest
@testable import ManorCore

final class GitHelperParsingTests: XCTestCase {

    // MARK: - Single worktree

    func testParseSingleMainWorktree() {
        let output = """
        worktree /Users/user/projects/myrepo
        HEAD abc123def456
        branch refs/heads/main

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].path, "/Users/user/projects/myrepo")
        XCTAssertEqual(result[0].branch, "main")
        XCTAssertTrue(result[0].isMain)
        XCTAssertTrue(result[0].isCheckedOut)
    }

    func testParseMultipleWorktrees() {
        let output = """
        worktree /Users/user/projects/myrepo
        HEAD abc123
        branch refs/heads/main

        worktree /Users/user/.manor/worktrees/myrepo/feature-foo
        HEAD def456
        branch refs/heads/feature/foo

        worktree /Users/user/.manor/worktrees/myrepo/fix-bar
        HEAD 789abc
        branch refs/heads/fix/bar

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 3)

        XCTAssertEqual(result[0].branch, "main")
        XCTAssertTrue(result[0].isMain)

        XCTAssertEqual(result[1].branch, "feature/foo")
        XCTAssertFalse(result[1].isMain)

        XCTAssertEqual(result[2].branch, "fix/bar")
        XCTAssertFalse(result[2].isMain)
    }

    func testParseDetachedHeadWorktree() {
        let output = """
        worktree /Users/user/projects/myrepo
        HEAD abc123
        branch refs/heads/main

        worktree /Users/user/.manor/worktrees/myrepo/detached
        HEAD deadbeef
        detached

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 2)
        XCTAssertFalse(result[1].isCheckedOut, "Detached worktree should not be marked as checked out")
        XCTAssertEqual(result[1].branch, "HEAD", "Detached worktree should fall back to HEAD")
    }

    func testParseBareWorktree() {
        let output = """
        worktree /Users/user/projects/myrepo.git
        HEAD abc123
        bare

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertFalse(result[0].isCheckedOut, "Bare worktree should not be marked as checked out")
    }

    func testParseEmptyOutput() {
        let result = GitHelper.parseWorktreePorcelain("")
        XCTAssertTrue(result.isEmpty)
    }

    func testParseOutputWithoutTrailingNewline() {
        // Git sometimes omits the trailing blank line
        let output = """
        worktree /Users/user/projects/myrepo
        HEAD abc123
        branch refs/heads/main
        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].branch, "main")
    }

    func testParseBranchWithSlashesStrippedOfRefsHeads() {
        let output = """
        worktree /Users/user/projects/myrepo
        HEAD abc123
        branch refs/heads/team/feature/login

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].branch, "team/feature/login")
    }

    func testFirstWorktreeIsAlwaysMain() {
        let output = """
        worktree /path/to/first
        HEAD aaa
        branch refs/heads/develop

        worktree /path/to/second
        HEAD bbb
        branch refs/heads/main

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 2)
        XCTAssertTrue(result[0].isMain, "First worktree is always isMain regardless of branch name")
        XCTAssertFalse(result[1].isMain)
    }

    func testParseBranchWithoutRefsHeadsPrefix() {
        // If git returns a branch without refs/heads/ prefix, it should be used as-is
        let output = """
        worktree /Users/user/projects/myrepo
        HEAD abc123
        branch main

        """

        let result = GitHelper.parseWorktreePorcelain(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].branch, "main")
    }
}
