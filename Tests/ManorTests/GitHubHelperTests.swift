import XCTest
@testable import ManorCore

final class GitHubHelperTests: XCTestCase {

    // MARK: - parseCount

    private let insertionRegex = try! NSRegularExpression(pattern: #"(\d+) insertion"#)
    private let deletionRegex = try! NSRegularExpression(pattern: #"(\d+) deletion"#)

    func testParseAdditionsCount() {
        let output = " 3 files changed, 245 insertions(+), 65 deletions(-)"
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: output), 245)
    }

    func testParseDeletionsCount() {
        let output = " 3 files changed, 245 insertions(+), 65 deletions(-)"
        XCTAssertEqual(GitHubHelper.parseCount(regex: deletionRegex, in: output), 65)
    }

    func testParseAdditionsOnly() {
        let output = " 1 file changed, 42 insertions(+)"
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: output), 42)
        XCTAssertEqual(GitHubHelper.parseCount(regex: deletionRegex, in: output), 0)
    }

    func testParseDeletionsOnly() {
        let output = " 1 file changed, 5 deletions(-)"
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: output), 0)
        XCTAssertEqual(GitHubHelper.parseCount(regex: deletionRegex, in: output), 5)
    }

    func testParseEmptyStringReturnsZero() {
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: ""), 0)
        XCTAssertEqual(GitHubHelper.parseCount(regex: deletionRegex, in: ""), 0)
    }

    func testParseGarbageInputReturnsZero() {
        let output = "no changes"
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: output), 0)
        XCTAssertEqual(GitHubHelper.parseCount(regex: deletionRegex, in: output), 0)
    }

    func testParseLargeNumbers() {
        let output = " 100 files changed, 12345 insertions(+), 9876 deletions(-)"
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: output), 12345)
        XCTAssertEqual(GitHubHelper.parseCount(regex: deletionRegex, in: output), 9876)
    }

    func testParseSingleInsertion() {
        // Singular form: "1 insertion(+)"
        let output = " 1 file changed, 1 insertion(+)"
        XCTAssertEqual(GitHubHelper.parseCount(regex: insertionRegex, in: output), 1)
    }

    // MARK: - PRState raw values

    func testPRStateOpenParsesFromLowercase() {
        XCTAssertEqual(GitHubPRInfo.PRState(rawValue: "open"), .open)
    }

    func testPRStateClosedParsesFromLowercase() {
        XCTAssertEqual(GitHubPRInfo.PRState(rawValue: "closed"), .closed)
    }

    func testPRStateMergedParsesFromLowercase() {
        XCTAssertEqual(GitHubPRInfo.PRState(rawValue: "merged"), .merged)
    }

    func testPRStateUnknownRawValueReturnsNil() {
        XCTAssertNil(GitHubPRInfo.PRState(rawValue: "OPEN"))
        XCTAssertNil(GitHubPRInfo.PRState(rawValue: "unknown"))
    }
}
