import SwiftUI
import ManorCore

// MARK: - Pane Layout View

/// Recursive SwiftUI view that renders a PaneNode binary tree.
/// Leaf nodes render a GhosttySurfaceRepresentable; branch nodes render
/// a PaneSplitView with a draggable divider.
struct PaneLayoutView: View {
    let node: PaneNode
    let path: [Int]
    @EnvironmentObject var appState: AppState

    var body: some View {
        switch node {
        case .leaf(let paneID):
            GhosttySurfaceRepresentable(paneID: paneID)
                .id(paneID.id)

        case .split(let direction, let ratio, let first, let second):
            PaneSplitView(
                direction: direction,
                ratio: ratio,
                onRatioChanged: { newRatio in
                    appState.updatePaneRatio(at: path, newRatio: newRatio)
                }
            ) {
                PaneLayoutView(node: first, path: path + [0])
            } second: {
                PaneLayoutView(node: second, path: path + [1])
            }
        }
    }
}

// MARK: - Split View

/// Lays out two child views with a draggable divider between them.
struct PaneSplitView<First: View, Second: View>: View {
    let direction: SplitDirection
    let ratio: CGFloat
    let onRatioChanged: (CGFloat) -> Void
    @ViewBuilder let first: First
    @ViewBuilder let second: Second

    @EnvironmentObject var themeManager: ThemeManager

    private let dividerWidth: CGFloat = 6

    @State private var isDragging = false
    @State private var dragStartRatio: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let totalSize = direction == .horizontal ? geo.size.width : geo.size.height
            let available = max(1, totalSize - dividerWidth)
            let firstSize = available * ratio

            if direction == .horizontal {
                HStack(spacing: 0) {
                    first.frame(width: max(0, firstSize))
                    dividerView(available: available)
                        .frame(width: dividerWidth)
                    second
                }
            } else {
                VStack(spacing: 0) {
                    first.frame(height: max(0, firstSize))
                    dividerView(available: available)
                        .frame(height: dividerWidth)
                    second
                }
            }
        }
    }

    private func dividerView(available: CGFloat) -> some View {
        Rectangle()
            .fill(Color(nsColor: themeManager.current.dividerColor))
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    (direction == .horizontal ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture()
                    .onChanged { value in
                        if !isDragging {
                            isDragging = true
                            dragStartRatio = ratio
                        }
                        let delta = direction == .horizontal ? value.translation.width : value.translation.height
                        let startFirst = available * dragStartRatio
                        let newRatio = max(0.1, min(0.9, (startFirst + delta) / available))
                        onRatioChanged(newRatio)
                    }
                    .onEnded { _ in
                        isDragging = false
                    }
            )
    }
}
