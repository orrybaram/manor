import SwiftUI
import ManorCore

// MARK: - Sidebar Container

/// SwiftUI sidebar that contains the projects list and active ports.
/// Reads directly from AppState — no intermediate view models.
struct SidebarContainerView: View {
    @EnvironmentObject var appState: AppState

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    var body: some View {
        VStack(spacing: 0) {
            // Traffic light area
            Spacer().frame(height: LayoutConstants.tabBarHeight)

            // Header
            SidebarHeader()
                .frame(height: 36)

            // Projects list
            ScrollView(.vertical, showsIndicators: false) {
                SidebarProjectsView()
            }

            Spacer(minLength: 0)

            // Ports section (pinned to bottom)
            if !appState.activePorts.isEmpty {
                ThemeDivider()

                SidebarPortsView()
            }
        }
        .background(Color(nsColor: theme.sidebarBackground))
        .overlay(alignment: .trailing) {
            ThemeDivider(vertical: true)
        }
        .onChange(of: appState.projects.count) { _ in
            appState.updatePortScannerWorktreePaths()
        }
    }
}

// MARK: - Sidebar Header

private struct SidebarHeader: View {
    @EnvironmentObject var appState: AppState

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    var body: some View {
        HStack {
            Text("PROJECTS")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Color(nsColor: theme.dimText))
                .padding(.leading, 12)

            Spacer()

            Button {
                appState.addProject()
            } label: {
                Text("Add +")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(Color(nsColor: theme.dimText))
            }
            .buttonStyle(.plain)
            .padding(.trailing, 12)
        }
    }
}

// MARK: - Sidebar Resize Handle

struct SidebarResizeHandle: View {
    @EnvironmentObject var appState: AppState

    @State private var isDragging = false
    @State private var startWidth: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 5)
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture()
                    .onChanged { value in
                        if !isDragging {
                            isDragging = true
                            startWidth = appState.sidebarWidth
                        }
                        let newWidth = max(LayoutConstants.sidebarMinWidth, min(LayoutConstants.sidebarMaxWidth, startWidth + value.translation.width))
                        appState.sidebarWidth = newWidth
                    }
                    .onEnded { _ in
                        isDragging = false
                        UserDefaults.standard.set(appState.sidebarWidth, forKey: "sidebarWidth")
                    }
            )
    }
}
