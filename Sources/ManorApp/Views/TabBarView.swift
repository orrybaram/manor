import AppKit
import ManorCore

/// Box that holds a weak reference, used to safely pass to CVDisplayLink callbacks.
private final class Weak<T: AnyObject> {
    weak var value: T?
    init(_ value: T) { self.value = value }
}

@MainActor protocol TabBarDelegate: AnyObject {
    func tabBar(_ tabBar: TabBarView, didSelectTabAt index: Int)
    func tabBar(_ tabBar: TabBarView, didCloseTabAt index: Int)
    func tabBar(_ tabBar: TabBarView, didMoveTabFrom fromIndex: Int, to toIndex: Int)
    func tabBarDidRequestNewTab(_ tabBar: TabBarView)
}

final class TabBarView: NSView {
    weak var delegate: TabBarDelegate?

    private var tabs: [(id: UUID, title: String)] = []
    private var selectedIndex: Int = 0

    private let tabHeight: CGFloat = 28
    private let tabMinWidth: CGFloat = 100
    private let tabMaxWidth: CGFloat = 200
    private let leadingInset: CGFloat = 8
    // Drag state
    private var dragTabIndex: Int?
    private var dragCurrentX: CGFloat = 0
    private var dragStartX: CGFloat = 0
    private var isDragging = false
    private let dragThreshold: CGFloat = 4
    private let swapThreshold: CGFloat = 0.5 // swap when crossing 50% into neighbor

    // Animation state: per-tab X offset that decays to 0
    private var animationOffsets: [UUID: CGFloat] = [:]
    private var displayLink: CVDisplayLink?
    private var displayLinkBox: UnsafeMutableRawPointer?

    private var theme: GhosttyTheme { GhosttyApp.shared.theme }
    private var backgroundColor: NSColor { theme.tabBarBackground }
    private var selectedTabColor: NSColor { theme.selectedTabBackground }
    private var tabTextColor: NSColor { theme.primaryText }
    private var selectedTextColor: NSColor { theme.selectedText }

    // Cached text attributes (reused across draw calls)
    private static let paragraphStyle: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        style.lineBreakMode = .byTruncatingTail
        return style
    }()

    private var currentTabWidth: CGFloat {
        guard !tabs.isEmpty else { return tabMinWidth }
        return min(tabMaxWidth, max(tabMinWidth, (bounds.width - leadingInset - 30) / CGFloat(tabs.count)))
    }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame: NSRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        wantsLayer = true
        layer?.backgroundColor = backgroundColor.cgColor
    }

    deinit {
        stopDisplayLink()
    }

    private func startDisplayLink() {
        guard displayLink == nil else { return }
        var link: CVDisplayLink?
        CVDisplayLinkCreateWithActiveCGDisplays(&link)
        guard let link else { return }
        // Use a weak reference to avoid use-after-free if the view is deallocated
        // while the display link callback is in-flight on a background thread.
        let weakBox = Weak(self)
        let boxPtr = UnsafeMutableRawPointer(Unmanaged.passRetained(weakBox).toOpaque())
        CVDisplayLinkSetOutputCallback(link, { _, _, _, _, _, userInfo -> CVReturn in
            guard let userInfo else { return kCVReturnSuccess }
            let box = Unmanaged<Weak<TabBarView>>.fromOpaque(userInfo).takeUnretainedValue()
            DispatchQueue.main.async {
                box.value?.animateOffsets()
            }
            return kCVReturnSuccess
        }, boxPtr)
        CVDisplayLinkStart(link)
        displayLink = link
        displayLinkBox = boxPtr
    }

    private func stopDisplayLink() {
        if let link = displayLink {
            CVDisplayLinkStop(link)
            displayLink = nil
        }
        if let boxPtr = displayLinkBox {
            Unmanaged<Weak<TabBarView>>.fromOpaque(boxPtr).release()
            displayLinkBox = nil
        }
    }

    private func animateOffsets() {
        guard !animationOffsets.isEmpty else {
            stopDisplayLink()
            return
        }
        let decay: CGFloat = 0.1 // lerp factor per frame
        for (id, offset) in animationOffsets {
            let newOffset = offset * (1 - decay)
            if abs(newOffset) < 0.5 {
                animationOffsets.removeValue(forKey: id)
            } else {
                animationOffsets[id] = newOffset
            }
        }
        needsDisplay = true
        if animationOffsets.isEmpty {
            stopDisplayLink()
        }
    }

    func update(tabs: [(id: UUID, title: String)], selectedIndex: Int) {
        self.tabs = tabs
        self.selectedIndex = selectedIndex
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        // Background
        context.setFillColor(backgroundColor.cgColor)
        context.fill(bounds)

        guard !tabs.isEmpty else { return }

        let tabWidth = currentTabWidth

        // Draw non-dragged tabs first, then the dragged tab on top
        let dragOffset = isDragging ? (dragCurrentX - dragStartX) : 0

        for pass in 0...1 {
            for (i, tab) in tabs.enumerated() {
                let isDraggedTab = isDragging && i == dragTabIndex
                // Pass 0: draw non-dragged tabs; Pass 1: draw dragged tab
                if pass == 0 && isDraggedTab { continue }
                if pass == 1 && !isDraggedTab { continue }

                var x = leadingInset + CGFloat(i) * tabWidth
                if isDraggedTab {
                    x += dragOffset
                    // Clamp to tab bar bounds
                    x = max(leadingInset, min(x, leadingInset + CGFloat(tabs.count - 1) * tabWidth))
                } else if let animOffset = animationOffsets[tab.id] {
                    x += animOffset
                }
                let rect = CGRect(x: x, y: 0, width: tabWidth, height: tabHeight)

                // Tab background
                if i == selectedIndex {
                    context.setFillColor(selectedTabColor.cgColor)
                    context.fill(rect)
                }

                // Tab title
                let isSelected = i == selectedIndex
                let attrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: isSelected ? selectedTextColor : tabTextColor,
                    .font: NSFont.systemFont(ofSize: 11, weight: isSelected ? .medium : .regular),
                    .paragraphStyle: Self.paragraphStyle,
                ]

                let title = tab.title as NSString
                let textRect = CGRect(x: x + 8, y: 6, width: tabWidth - 24, height: 16)
                title.draw(in: textRect, withAttributes: attrs)

                // Close button area (small x)
                let closeX = x + tabWidth - 18
                let closeStr = "\u{00D7}" as NSString // ×
                let closeAttrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: tabTextColor.withAlphaComponent(0.5),
                    .font: NSFont.systemFont(ofSize: 12),
                ]
                closeStr.draw(at: CGPoint(x: closeX, y: 6), withAttributes: closeAttrs)

                // Separator (skip for dragged tab)
                if !isDraggedTab && i < tabs.count - 1 && i != selectedIndex && i != selectedIndex - 1 {
                    context.setStrokeColor(NSColor(white: 0.25, alpha: 1).cgColor)
                    context.setLineWidth(1)
                    context.move(to: CGPoint(x: x + tabWidth, y: 4))
                    context.addLine(to: CGPoint(x: x + tabWidth, y: tabHeight - 4))
                    context.strokePath()
                }
            }
        }

        // New tab button (+)
        let plusX = leadingInset + CGFloat(tabs.count) * tabWidth + 8
        let plusAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: tabTextColor,
            .font: NSFont.systemFont(ofSize: 14, weight: .light),
        ]
        ("+  " as NSString).draw(at: CGPoint(x: plusX, y: 5), withAttributes: plusAttrs)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let tabWidth = currentTabWidth

        // Traffic light area — let the window handle it
        guard point.x >= leadingInset else {
            window?.performDrag(with: event)
            return
        }

        // Check new tab button (+)
        let plusX = leadingInset + CGFloat(tabs.count) * tabWidth + 8
        if point.x >= plusX && point.x <= plusX + 20 {
            delegate?.tabBarDidRequestNewTab(self)
            return
        }

        let clickedIndex = Int((point.x - leadingInset) / tabWidth)
        guard clickedIndex >= 0, clickedIndex < tabs.count else {
            // Empty area — drag the window
            window?.performDrag(with: event)
            return
        }

        // Check close button (small × drawn at tabWidth - 18, roughly 12px wide)
        let tabOrigin = leadingInset + CGFloat(clickedIndex) * tabWidth
        let closeLeft = tabOrigin + tabWidth - 22
        let closeRight = tabOrigin + tabWidth - 4
        if point.x >= closeLeft && point.x <= closeRight && point.y >= 2 && point.y <= 22 {
            delegate?.tabBar(self, didCloseTabAt: clickedIndex)
            return
        }

        // Start potential drag
        dragTabIndex = clickedIndex
        dragStartX = point.x
        dragCurrentX = point.x
        isDragging = false

        delegate?.tabBar(self, didSelectTabAt: clickedIndex)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let dragIndex = dragTabIndex, tabs.count > 1 else { return }
        let point = convert(event.locationInWindow, from: nil)
        dragCurrentX = point.x

        if !isDragging {
            if abs(dragCurrentX - dragStartX) > dragThreshold {
                isDragging = true
            } else {
                return
            }
        }

        let tabWidth = currentTabWidth
        let draggedTabEdgeOffset = tabWidth * swapThreshold

        // Check if we should swap with the left neighbor
        if dragIndex > 0 {
            let leftEdge = leadingInset + CGFloat(dragIndex) * tabWidth + (dragCurrentX - dragStartX)
            let leftSwapLine = leadingInset + CGFloat(dragIndex - 1) * tabWidth + tabWidth - draggedTabEdgeOffset
            if leftEdge < leftSwapLine {
                swapDraggedTab(from: dragIndex, to: dragIndex - 1, tabWidth: tabWidth)
            }
        }

        // Check if we should swap with the right neighbor
        if let di = dragTabIndex, di < tabs.count - 1 {
            let rightEdge = leadingInset + CGFloat(di) * tabWidth + tabWidth + (dragCurrentX - dragStartX)
            let rightSwapLine = leadingInset + CGFloat(di + 1) * tabWidth + draggedTabEdgeOffset
            if rightEdge > rightSwapLine {
                swapDraggedTab(from: di, to: di + 1, tabWidth: tabWidth)
            }
        }

        needsDisplay = true
    }

    /// Swap the dragged tab with an adjacent tab, updating indices and starting the displacement animation.
    private func swapDraggedTab(from sourceIndex: Int, to destIndex: Int, tabWidth: CGFloat) {
        let displacedID = tabs[destIndex].id
        tabs.swapAt(sourceIndex, destIndex)

        if selectedIndex == sourceIndex {
            selectedIndex = destIndex
        } else if selectedIndex == destIndex {
            selectedIndex = sourceIndex
        }

        let direction: CGFloat = destIndex < sourceIndex ? 1 : -1
        dragStartX -= direction * tabWidth
        dragTabIndex = destIndex

        animationOffsets[displacedID] = -direction * tabWidth
        startDisplayLink()
        delegate?.tabBar(self, didMoveTabFrom: sourceIndex, to: destIndex)
    }

    override func mouseUp(with event: NSEvent) {
        isDragging = false
        dragTabIndex = nil
        needsDisplay = true
    }

    override func resetCursorRects() {
        let tabWidth = currentTabWidth
        for i in 0..<tabs.count {
            let x = leadingInset + CGFloat(i) * tabWidth
            addCursorRect(CGRect(x: x, y: 0, width: tabWidth, height: tabHeight), cursor: .pointingHand)
        }
        let plusX = leadingInset + CGFloat(tabs.count) * tabWidth + 8
        addCursorRect(CGRect(x: plusX, y: 0, width: 24, height: tabHeight), cursor: .pointingHand)
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: tabHeight)
    }
}
