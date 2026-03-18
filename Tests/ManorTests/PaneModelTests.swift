import XCTest
@testable import ManorCore

final class PaneModelTests: XCTestCase {

    // MARK: - insertSplit

    func testInsertSplitOnLeafCreatesHorizontalSplit() {
        let id = PaneID()
        let newID = PaneID()
        let tree = PaneNode.leaf(id)

        let result = tree.insertSplit(at: id, direction: .horizontal, newID: newID)

        guard case .split(let dir, let ratio, let first, let second) = result else {
            XCTFail("Expected split node")
            return
        }
        XCTAssertEqual(dir, .horizontal)
        XCTAssertEqual(ratio, 0.5)
        guard case .leaf(let firstID) = first, case .leaf(let secondID) = second else {
            XCTFail("Expected two leaf children")
            return
        }
        XCTAssertEqual(firstID, id)
        XCTAssertEqual(secondID, newID)
    }

    func testInsertSplitBeforePlacesNewPaneFirst() {
        let id = PaneID()
        let newID = PaneID()
        let tree = PaneNode.leaf(id)

        let result = tree.insertSplit(at: id, direction: .vertical, newID: newID, before: true)

        guard case .split(_, _, let first, let second) = result else {
            XCTFail("Expected split node")
            return
        }
        guard case .leaf(let firstID) = first, case .leaf(let secondID) = second else {
            XCTFail("Expected two leaf children")
            return
        }
        XCTAssertEqual(firstID, newID, "New pane should come first when before: true")
        XCTAssertEqual(secondID, id, "Existing pane should come second when before: true")
    }

    func testInsertSplitOnNonTargetLeafReturnsUnchanged() {
        let id = PaneID()
        let otherId = PaneID()
        let newID = PaneID()
        let tree = PaneNode.leaf(id)

        let result = tree.insertSplit(at: otherId, direction: .horizontal, newID: newID)

        guard case .leaf(let leafID) = result else {
            XCTFail("Expected unchanged leaf")
            return
        }
        XCTAssertEqual(leafID, id)
    }

    func testInsertSplitIntoNestedTree() {
        let a = PaneID()
        let b = PaneID()
        let c = PaneID()
        // Start: split(a, b)
        let tree = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(a), second: .leaf(b))

        // Split b into b|c
        let result = tree.insertSplit(at: b, direction: .vertical, newID: c)

        XCTAssertEqual(result.allPaneIDs.count, 3)
        XCTAssertTrue(result.contains(a))
        XCTAssertTrue(result.contains(b))
        XCTAssertTrue(result.contains(c))
    }

    // MARK: - removing

    func testRemovingOnlyPaneReturnsNil() {
        let id = PaneID()
        let tree = PaneNode.leaf(id)

        XCTAssertNil(tree.removing(id))
    }

    func testRemovingNonExistentIDReturnsUnchanged() {
        let id = PaneID()
        let other = PaneID()
        let tree = PaneNode.leaf(id)

        let result = tree.removing(other)
        XCTAssertNotNil(result)
        guard case .leaf(let leafID) = result else {
            XCTFail("Expected leaf")
            return
        }
        XCTAssertEqual(leafID, id)
    }

    func testRemovingFirstChildCollapsesToSecond() {
        let a = PaneID()
        let b = PaneID()
        let tree = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(a), second: .leaf(b))

        let result = tree.removing(a)

        guard let result, case .leaf(let id) = result else {
            XCTFail("Expected single leaf after removal")
            return
        }
        XCTAssertEqual(id, b)
    }

    func testRemovingSecondChildCollapsesToFirst() {
        let a = PaneID()
        let b = PaneID()
        let tree = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(a), second: .leaf(b))

        let result = tree.removing(b)

        guard let result, case .leaf(let id) = result else {
            XCTFail("Expected single leaf after removal")
            return
        }
        XCTAssertEqual(id, a)
    }

    func testRemovingFromThreePaneTree() {
        let a = PaneID()
        let b = PaneID()
        let c = PaneID()
        // split(a, split(b, c))
        let inner = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(b), second: .leaf(c))
        let tree = PaneNode.split(direction: .vertical, ratio: 0.5, first: .leaf(a), second: inner)

        let result = tree.removing(b)

        XCTAssertNotNil(result)
        XCTAssertEqual(result?.allPaneIDs.count, 2)
        XCTAssertTrue(result?.contains(a) ?? false)
        XCTAssertTrue(result?.contains(c) ?? false)
        XCTAssertFalse(result?.contains(b) ?? true)
    }

    // MARK: - withUpdatedRatio

    func testUpdateRatioAtRoot() {
        let a = PaneID()
        let b = PaneID()
        let tree = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(a), second: .leaf(b))

        let result = tree.withUpdatedRatio(at: [], newRatio: 0.7)

        guard case .split(_, let ratio, _, _) = result else {
            XCTFail("Expected split node")
            return
        }
        XCTAssertEqual(ratio, 0.7, accuracy: 0.001)
    }

    func testUpdateRatioOnLeafIsNoOp() {
        let id = PaneID()
        let tree = PaneNode.leaf(id)
        let result = tree.withUpdatedRatio(at: [], newRatio: 0.8)
        // Leaf nodes ignore ratio updates
        guard case .leaf(let leafID) = result else {
            XCTFail("Expected leaf")
            return
        }
        XCTAssertEqual(leafID, id)
    }

    func testUpdateRatioAtNestedPath() {
        let a = PaneID()
        let b = PaneID()
        let c = PaneID()
        let inner = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(b), second: .leaf(c))
        let tree = PaneNode.split(direction: .vertical, ratio: 0.5, first: .leaf(a), second: inner)

        // Path [1] = second child (inner split)
        let result = tree.withUpdatedRatio(at: [1], newRatio: 0.3)

        guard case .split(_, let outerRatio, _, let second) = result else {
            XCTFail("Expected outer split")
            return
        }
        XCTAssertEqual(outerRatio, 0.5, accuracy: 0.001, "Outer ratio should be unchanged")

        guard case .split(_, let innerRatio, _, _) = second else {
            XCTFail("Expected inner split")
            return
        }
        XCTAssertEqual(innerRatio, 0.3, accuracy: 0.001, "Inner ratio should be updated")
    }

    // MARK: - allPaneIDs

    func testAllPaneIDsSingleLeaf() {
        let id = PaneID()
        XCTAssertEqual(PaneNode.leaf(id).allPaneIDs, [id])
    }

    func testAllPaneIDsPreservesOrder() {
        let a = PaneID()
        let b = PaneID()
        let c = PaneID()
        // split(a, split(b, c)) → order should be [a, b, c]
        let inner = PaneNode.split(direction: .horizontal, ratio: 0.5, first: .leaf(b), second: .leaf(c))
        let tree = PaneNode.split(direction: .vertical, ratio: 0.5, first: .leaf(a), second: inner)

        XCTAssertEqual(tree.allPaneIDs, [a, b, c])
    }

    // MARK: - contains

    func testContainsPresentID() {
        let id = PaneID()
        XCTAssertTrue(PaneNode.leaf(id).contains(id))
    }

    func testContainsMissingID() {
        let id = PaneID()
        let other = PaneID()
        XCTAssertFalse(PaneNode.leaf(id).contains(other))
    }

    // MARK: - Codable round-trip

    func testCodableRoundTripLeaf() throws {
        let id = PaneID()
        let tree = PaneNode.leaf(id)

        let data = try JSONEncoder().encode(tree)
        let decoded = try JSONDecoder().decode(PaneNode.self, from: data)

        guard case .leaf(let decodedID) = decoded else {
            XCTFail("Expected leaf after decode")
            return
        }
        XCTAssertEqual(decodedID.id, id.id)
    }

    func testCodableRoundTripNestedSplit() throws {
        let a = PaneID()
        let b = PaneID()
        let c = PaneID()
        let inner = PaneNode.split(direction: .vertical, ratio: 0.3, first: .leaf(b), second: .leaf(c))
        let tree = PaneNode.split(direction: .horizontal, ratio: 0.6, first: .leaf(a), second: inner)

        let data = try JSONEncoder().encode(tree)
        let decoded = try JSONDecoder().decode(PaneNode.self, from: data)

        XCTAssertEqual(decoded.allPaneIDs.map(\.id), [a.id, b.id, c.id])
    }
}
