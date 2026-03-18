import SwiftUI
import ManorCore

// MARK: - Theme Divider

/// A 1pt divider line using the theme's divider color.
struct ThemeDivider: View {
    let vertical: Bool

    init(vertical: Bool = false) {
        self.vertical = vertical
    }

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    var body: some View {
        Rectangle()
            .fill(Color(nsColor: theme.dividerColor))
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

// MARK: - Window Draggable Area

/// An NSView background that enables window dragging from non-interactive areas.
struct WindowDraggableArea: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowDraggableNSView {
        WindowDraggableNSView()
    }

    func updateNSView(_ nsView: WindowDraggableNSView, context: Context) {}
}

final class WindowDraggableNSView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
}
