import SwiftUI
import ManorCore

// MARK: - View

struct SidebarPortsView: View {
    @EnvironmentObject var appState: AppState

    @State private var isExpanded: Bool = true
    @State private var hoveredPortID: UInt16? = nil
    @State private var isHeaderHovered: Bool = false

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    private var worktreeLabels: [String: String] {
        var labels: [String: String] = [:]
        for project in appState.projects {
            for wt in project.worktreeModels {
                labels[wt.info.path] = wt.label
            }
        }
        return labels
    }

    var body: some View {
        VStack(spacing: 0) {
            sectionHeader
            if isExpanded && !appState.activePorts.isEmpty {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(appState.activePorts) { port in
                            portRow(port: port)
                        }
                    }
                }
                .frame(maxHeight: 200)
            }
        }
    }

    // MARK: - Section Header

    private var sectionHeader: some View {
        ZStack(alignment: .leading) {
            if isHeaderHovered {
                Color(nsColor: theme.hoverBackground)
            }

            HStack(spacing: 0) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .regular))
                    .foregroundColor(Color(nsColor: theme.dimText))
                    .frame(width: 16)
                    .padding(.leading, 5)

                Text("PORTS")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(Color(nsColor: theme.dimText))
                    .padding(.leading, 4)

                Spacer()
            }
        }
        .frame(height: 28)
        .contentShape(Rectangle())
        .onHover { isHeaderHovered = $0 }
        .onTapGesture {
            isExpanded.toggle()
        }
    }

    // MARK: - Port Row

    private func portRow(port: ActivePort) -> some View {
        let isHovered = hoveredPortID == port.id
        let worktreeLabel = port.worktreePath.flatMap { worktreeLabels[$0] }

        return ZStack(alignment: .leading) {
            if isHovered {
                Color(nsColor: theme.hoverBackground)
            }

            HStack(spacing: 0) {
                // Green dot
                Circle()
                    .fill(Color(red: 0.3, green: 0.8, blue: 0.4))
                    .frame(width: 6, height: 6)
                    .padding(.leading, 12)

                // Port + process name
                Button {
                    appState.clickPort(port)
                } label: {
                    Text(":\(port.port) \(port.processName)")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundColor(Color(nsColor: isHovered ? theme.selectedText : theme.primaryText))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .buttonStyle(.plain)
                .padding(.leading, 6)

                Spacer(minLength: 4)

                // Worktree label (clickable)
                if let label = worktreeLabel {
                    Button {
                        appState.clickPortWorktree(port)
                    } label: {
                        Text(label)
                            .font(.system(size: 9))
                            .foregroundColor(Color(nsColor: theme.dimText))
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 10)
                }
            }
        }
        .frame(height: 22)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering {
                hoveredPortID = port.id
            } else if hoveredPortID == port.id {
                hoveredPortID = nil
            }
        }
    }
}
