import Combine
import ManorCore

/// Observable theme manager. Views inject this as @EnvironmentObject and use
/// `themeManager.current` for reactive theme access. Theme changes from
/// Ghostty callbacks trigger reactive re-renders via @Published.
@MainActor
final class ThemeManager: ObservableObject {
    @Published var current: GhosttyTheme

    init() {
        self.current = GhosttyApp.shared.theme
    }

    /// Call when Ghostty reports a theme/color change.
    func reloadFromGhostty() {
        current = GhosttyApp.shared.theme
    }
}
