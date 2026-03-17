import Foundation

// MARK: - Split Direction

enum SplitDirection {
    case horizontal // side by side
    case vertical   // top and bottom
}

// MARK: - Pane Node (Binary Tree)

/// Binary tree representing the pane layout.
/// Leaf nodes hold a terminal pane ID.
/// Branch nodes hold a split direction and ratio.
indirect enum PaneNode {
    case leaf(PaneID)
    case split(direction: SplitDirection, ratio: CGFloat, first: PaneNode, second: PaneNode)

    var allPaneIDs: [PaneID] {
        switch self {
        case .leaf(let id):
            return [id]
        case .split(_, _, let first, let second):
            return first.allPaneIDs + second.allPaneIDs
        }
    }

    func contains(_ id: PaneID) -> Bool {
        switch self {
        case .leaf(let leafID):
            return leafID == id
        case .split(_, _, let first, let second):
            return first.contains(id) || second.contains(id)
        }
    }

    /// Replace a leaf with a split containing the original leaf and a new leaf.
    func insertSplit(at targetID: PaneID, direction: SplitDirection, newID: PaneID, before: Bool = false) -> PaneNode {
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

    /// Remove a leaf and collapse the tree.
    func removing(_ targetID: PaneID) -> PaneNode? {
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

// MARK: - Pane ID

struct PaneID: Hashable, Equatable {
    let id: UUID

    init() {
        self.id = UUID()
    }
}

// MARK: - Tab / Window Model

struct TabModel {
    let id: UUID
    var title: String
    var rootNode: PaneNode
    var focusedPaneID: PaneID

    init(paneID: PaneID, title: String = "Terminal") {
        self.id = UUID()
        self.title = title
        self.rootNode = .leaf(paneID)
        self.focusedPaneID = paneID
    }
}
