import SwiftUI
import ManorCore

// MARK: - Empty State View

struct EmptyStateSwiftUIView: View {
    @EnvironmentObject var appState: AppState

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    var body: some View {
        ZStack {
            Color(nsColor: theme.sidebarBackground)

            VStack(spacing: 0) {
                Spacer()

                // Pixel art M logo
                PixelArtLogo()
                    .padding(.bottom, 14)

                // MANOR wordmark
                Text("MANOR")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(white: 0.26))
                    .kerning(5)
                    .padding(.bottom, 60)

                // Action button
                switch appState.emptyStateMode {
                case .noTabs:
                    ActionButton(
                        icon: ">_",
                        iconFont: .system(size: 12, design: .monospaced),
                        label: "New Terminal",
                        shortcut: "⌘T",
                        theme: theme
                    ) {
                        appState.createNewTab()
                    }
                case .noProjects:
                    ActionButton(
                        icon: "+",
                        iconFont: .system(size: 14, weight: .regular),
                        label: "Add Project",
                        shortcut: "⇧⌘O",
                        theme: theme
                    ) {
                        appState.addProject()
                    }
                }

                Spacer()
            }
        }
    }
}

// MARK: - Pixel Art Logo

private struct PixelArtLogo: View {
    // 5-wide × 7-tall pixel art "M"
    private static let pixels: [[Bool]] = [
        [true,  false, false, false, true ],
        [true,  true,  false, true,  true ],
        [true,  false, true,  false, true ],
        [true,  false, false, false, true ],
        [true,  false, false, false, true ],
        [true,  false, false, false, true ],
        [true,  false, false, false, true ],
    ]

    private let pixelSize: CGFloat = 9
    private let gap: CGFloat = 3

    private var step: CGFloat { pixelSize + gap }
    private var totalWidth: CGFloat { CGFloat(Self.pixels[0].count) * step - gap }
    private var totalHeight: CGFloat { CGFloat(Self.pixels.count) * step - gap }

    var body: some View {
        Canvas { context, _ in
            for (row, rowPixels) in Self.pixels.enumerated() {
                for (col, filled) in rowPixels.enumerated() {
                    guard filled else { continue }
                    let rect = CGRect(
                        x: CGFloat(col) * step,
                        y: CGFloat(row) * step,
                        width: pixelSize,
                        height: pixelSize
                    )
                    context.fill(Path(rect), with: .color(Color(white: 0.38)))
                }
            }
        }
        .frame(width: totalWidth, height: totalHeight)
    }
}

// MARK: - Action Button

private struct ActionButton: View {
    let icon: String
    let iconFont: Font
    let label: String
    let shortcut: String
    let theme: GhosttyTheme
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                Text(icon)
                    .font(iconFont)
                    .foregroundColor(Color(white: 0.50))
                    .frame(width: 30, alignment: .leading)

                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Color(white: 0.80))

                Spacer()

                Text(shortcut)
                    .font(.system(size: 11))
                    .foregroundColor(Color(white: 0.32))
            }
            .padding(.horizontal, 14)
            .frame(width: 216, height: 38)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color(nsColor: isHovered ? theme.hoverBackground : theme.selectedTabBackground))
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .modifier(LinkPointerModifier())
    }
}

// MARK: - Link Pointer Modifier

private struct LinkPointerModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.pointerStyle(.link)
        } else {
            content
        }
    }
}
