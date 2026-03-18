import SwiftUI
import ManorCore

// MARK: - Root View

/// Top-level SwiftUI view composing sidebar, tab bar, and content area.
struct RootView: View {
    @ObservedObject var appState: AppState
    @EnvironmentObject var themeManager: ThemeManager

    private var theme: GhosttyTheme { themeManager.current }

    var body: some View {
        HStack(spacing: 0) {
            if appState.sidebarVisible {
                SidebarContainerView()
                    .frame(width: appState.sidebarWidth)

                SidebarResizeHandle()
            }

            VStack() {
                TabBarRepresentable()
                    .frame(height: LayoutConstants.tabBarHeight)
                    .zIndex(1)

                ThemeDivider()

                contentArea
            }
        }
        .ignoresSafeArea(.all, edges: .top)
        .background(Color(nsColor: theme.terminalBackground))
        .environmentObject(appState)
    }

    @ViewBuilder
    private var contentArea: some View {
        if let project = appState.currentProject,
           !project.tabs.isEmpty,
           project.selectedTabIndex < project.tabs.count
        {
            PaneLayoutView(node: project.tabs[project.selectedTabIndex].rootNode, path: [])
        } else {
            EmptyStateSwiftUIView()
        }
    }
}
