import Foundation

// MARK: - Split Direction

package enum SplitDirection: Codable {
    case horizontal // side by side
    case vertical   // top and bottom
}

// MARK: - Pane Node (Binary Tree)

/// Binary tree representing the pane layout.
/// Leaf nodes hold a terminal pane ID.
/// Branch nodes hold a split direction and ratio.
package indirect enum PaneNode {
    case leaf(PaneID)
    case split(direction: SplitDirection, ratio: CGFloat, first: PaneNode, second: PaneNode)

    package var allPaneIDs: [PaneID] {
        switch self {
        case .leaf(let id):
            return [id]
        case .split(_, _, let first, let second):
            return first.allPaneIDs + second.allPaneIDs
        }
    }

    package func contains(_ id: PaneID) -> Bool {
        switch self {
        case .leaf(let leafID):
            return leafID == id
        case .split(_, _, let first, let second):
            return first.contains(id) || second.contains(id)
        }
    }

    /// Replace a leaf with a split containing the original leaf and a new leaf.
    package func insertSplit(at targetID: PaneID, direction: SplitDirection, newID: PaneID, before: Bool = false) -> PaneNode {
        switch self {
        case .leaf(let id):
            if id == targetID {
                let existing = PaneNode.leaf(id)
                let new = PaneNode.leaf(newID)
                if before {
                    return .split(direction: direction, ratio: 0.5, first: new, second: existing)
                } else {
                    return .split(direction: direction, ratio: 0.5, first: existing, second: new)
                }
            }
            return self

        case .split(let dir, let ratio, let first, let second):
            return .split(
                direction: dir,
                ratio: ratio,
                first: first.insertSplit(at: targetID, direction: direction, newID: newID, before: before),
                second: second.insertSplit(at: targetID, direction: direction, newID: newID, before: before)
            )
        }
    }

    /// Return a new tree with the ratio updated at the given path.
    package func withUpdatedRatio(at path: [Int], newRatio: CGFloat) -> PaneNode {
        switch self {
        case .leaf:
            return self
        case .split(let dir, let ratio, let first, let second):
            if path.isEmpty {
                return .split(direction: dir, ratio: newRatio, first: first, second: second)
            }
            let head = path[0]
            let rest = Array(path.dropFirst())
            if head == 0 {
                return .split(direction: dir, ratio: ratio, first: first.withUpdatedRatio(at: rest, newRatio: newRatio), second: second)
            } else {
                return .split(direction: dir, ratio: ratio, first: first, second: second.withUpdatedRatio(at: rest, newRatio: newRatio))
            }
        }
    }

    /// Remove a leaf and collapse the tree.
    package func removing(_ targetID: PaneID) -> PaneNode? {
        switch self {
        case .leaf(let id):
            return id == targetID ? nil : self

        case .split(let dir, let ratio, let first, let second):
            let newFirst = first.removing(targetID)
            let newSecond = second.removing(targetID)

            if let f = newFirst, let s = newSecond {
                return .split(direction: dir, ratio: ratio, first: f, second: s)
            }
            return newFirst ?? newSecond
        }
    }
}

extension PaneNode: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, paneID, direction, ratio, first, second
    }

    package func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .leaf(let id):
            try container.encode("leaf", forKey: .type)
            try container.encode(id, forKey: .paneID)
        case .split(let direction, let ratio, let first, let second):
            try container.encode("split", forKey: .type)
            try container.encode(direction, forKey: .direction)
            try container.encode(ratio, forKey: .ratio)
            try container.encode(first, forKey: .first)
            try container.encode(second, forKey: .second)
        }
    }

    package init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "leaf":
            let id = try container.decode(PaneID.self, forKey: .paneID)
            self = .leaf(id)
        case "split":
            let direction = try container.decode(SplitDirection.self, forKey: .direction)
            let ratio = try container.decode(CGFloat.self, forKey: .ratio)
            let first = try container.decode(PaneNode.self, forKey: .first)
            let second = try container.decode(PaneNode.self, forKey: .second)
            self = .split(direction: direction, ratio: ratio, first: first, second: second)
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown PaneNode type: \(type)")
        }
    }
}

// MARK: - Pane ID

package struct PaneID: Hashable, Equatable, Codable {
    package let id: UUID

    package init() {
        self.id = UUID()
    }

    package init(restoredID: UUID) {
        self.id = restoredID
    }
}

// MARK: - Tab / Window Model

package struct TabModel: Codable {
    package let id: UUID
    package var title: String
    package var rootNode: PaneNode
    package var focusedPaneID: PaneID

    package init(paneID: PaneID, title: String = "Terminal") {
        self.id = UUID()
        self.title = title
        self.rootNode = .leaf(paneID)
        self.focusedPaneID = paneID
    }
}
