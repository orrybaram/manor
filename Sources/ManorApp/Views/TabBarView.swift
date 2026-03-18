import AppKit
import SwiftUI
import ManorCore

// MARK: - Tab Bar Representable

/// Wraps TabBarHostingView in NSViewRepresentable to preserve window dragging
/// and double-click-to-zoom behavior from the custom NSHostingView subclass.
struct TabBarRepresentable: NSViewRepresentable {
    @EnvironmentObject var appState: AppState

    func makeNSView(context: Context) -> TabBarHostingView {
        TabBarHostingView(rootView: TabBarSwiftUIView(appState: appState))
    }

    func updateNSView(_ nsView: TabBarHostingView, context: Context) {
        // No-op: TabBarSwiftUIView observes appState via @ObservedObject,
        // so it updates itself reactively. Reassigning rootView here would
        // create a new SwiftUI view, destroying @State (draggedTabID, dragOffset)
        // and cancelling any in-progress tab drag.
    }
}

// MARK: - Tab Bar SwiftUI View

struct TabBarSwiftUIView: View {
    @ObservedObject var appState: AppState

    @State private var draggedTabID: UUID?
    @State private var dragOffset: CGFloat = 0

    private let tabHeight: CGFloat = LayoutConstants.tabBarHeight
    private let tabMinWidth: CGFloat = 100
    private let tabMaxWidth: CGFloat = 200
    private let leadingInset: CGFloat = 8
    private let dragThreshold: CGFloat = 4

    @EnvironmentObject var themeManager: ThemeManager
    private var theme: GhosttyTheme { themeManager.current }

    private func tabWidth(for count: Int, in totalWidth: CGFloat) -> CGFloat {
        guard count > 0 else { return tabMinWidth }
        return min(tabMaxWidth, max(tabMinWidth, (totalWidth - leadingInset - 30) / CGFloat(count)))
    }

    var body: some View {
        GeometryReader { geo in
            let tabs = appState.currentTabs
            let selectedIndex = appState.currentSelectedTabIndex
            let tw = tabWidth(for: tabs.count, in: geo.size.width)

            HStack(spacing: 0) {
                Spacer()
                    .frame(width: leadingInset)

                ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                    tabItemView(
                        tab: tab,
                        index: index,
                        selectedIndex: selectedIndex,
                        tabWidth: tw,
                        totalTabs: tabs.count
                    )
                }

                // New tab button
                Button { appState.createNewTab() } label: {
                    Text("+")
                        .font(.system(size: 14, weight: .light))
                        .foregroundColor(Color(nsColor: theme.primaryText))
                        .frame(width: 24, height: tabHeight)
                }
                .buttonStyle(.plain)
                .padding(.leading, 8)

                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: theme.tabBarBackground))
        }
        .frame(height: tabHeight)
    }

    @ViewBuilder
    private func tabItemView(
        tab: TabModel,
        index: Int,
        selectedIndex: Int,
        tabWidth: CGFloat,
        totalTabs: Int
    ) -> some View {
        let isSelected = index == selectedIndex
        let isDragged = draggedTabID == tab.id

        ZStack(alignment: .trailing) {
            // Tab title — centered
            Text(tab.title)
                .font(.system(size: 11, weight: isSelected ? .medium : .regular))
                .foregroundColor(Color(nsColor: isSelected ? theme.selectedText : theme.primaryText))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.leading, 8)
                .padding(.trailing, 20)

            // Close button
            Text("\u{00D7}")
                .font(.system(size: 12))
                .foregroundColor(Color(nsColor: theme.primaryText).opacity(0.5))
                .frame(width: 18, height: tabHeight)
                .contentShape(Rectangle())
                .highPriorityGesture(TapGesture().onEnded {
                    if let idx = appState.currentTabs.firstIndex(where: { $0.id == tab.id }) {
                        appState.closeTabAt(idx)
                    }
                })
                .padding(.trailing, 4)
        }
        .frame(width: tabWidth, height: tabHeight)
        .background(isSelected ? Color(nsColor: theme.selectedTabBackground) : Color.clear)
        .overlay(alignment: .trailing) {
            // Separator between tabs
            if !isDragged && index < totalTabs - 1
                && index != selectedIndex && index != selectedIndex - 1
            {
                Rectangle()
                    .fill(Color(white: 0.25))
                    .frame(width: 1)
                    .padding(.vertical, 4)
            }
        }
        .zIndex(isDragged ? 1 : 0)
        .offset(x: isDragged ? dragOffset : 0)
        .contentShape(Rectangle())
        .onTapGesture {
            if let idx = appState.currentTabs.firstIndex(where: { $0.id == tab.id }) {
                appState.selectTab(at: idx)
            }
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: dragThreshold)
                .onChanged { value in
                    if draggedTabID == nil {
                        draggedTabID = tab.id
                    }
                    dragOffset = value.translation.width
                    checkSwap(tabID: tab.id, tabWidth: tabWidth)
                }
                .onEnded { _ in
                    withAnimation(.easeOut(duration: 0.15)) {
                        draggedTabID = nil
                        dragOffset = 0
                    }
                }
        )
    }

    private func checkSwap(tabID: UUID, tabWidth: CGFloat) {
        let tabs = appState.currentTabs
        guard let currentIndex = tabs.firstIndex(where: { $0.id == tabID }),
              tabs.count > 1 else { return }

        let swapThreshold = tabWidth * 0.5

        if dragOffset > swapThreshold && currentIndex < tabs.count - 1 {
            appState.moveTab(from: currentIndex, to: currentIndex + 1)
            dragOffset -= tabWidth
        } else if dragOffset < -swapThreshold && currentIndex > 0 {
            appState.moveTab(from: currentIndex, to: currentIndex - 1)
            dragOffset += tabWidth
        }
    }
}

// MARK: - Tab Bar Hosting View

/// Custom NSHostingView subclass that provides an opaque background and
/// handles window dragging / double-click zoom from empty tab bar areas.
final class TabBarHostingView: NSHostingView<TabBarSwiftUIView> {
    required init(rootView: TabBarSwiftUIView) {
        super.init(rootView: rootView)
        wantsLayer = true
        layer?.isOpaque = true
        layer?.backgroundColor = GhosttyApp.shared.theme.tabBarBackground.cgColor
        layer?.zPosition = 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseUp(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.zoom(nil)
        }
        super.mouseUp(with: event)
    }
}
