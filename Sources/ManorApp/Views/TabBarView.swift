import AppKit

@MainActor protocol TabBarDelegate: AnyObject {
    func tabBar(_ tabBar: TabBarView, didSelectTabAt index: Int)
    func tabBar(_ tabBar: TabBarView, didCloseTabAt index: Int)
    func tabBarDidRequestNewTab(_ tabBar: TabBarView)
}

final class TabBarView: NSView {
    weak var delegate: TabBarDelegate?

    private var tabs: [(id: UUID, title: String)] = []
    private var selectedIndex: Int = 0

    private let tabHeight: CGFloat = 28
    private let tabMinWidth: CGFloat = 100
    private let tabMaxWidth: CGFloat = 200
    private let backgroundColor = NSColor(srgbRed: 0.12, green: 0.12, blue: 0.12, alpha: 1)
    private let selectedTabColor = NSColor(srgbRed: 0.18, green: 0.18, blue: 0.18, alpha: 1)
    private let tabTextColor = NSColor(srgbRed: 0.7, green: 0.7, blue: 0.7, alpha: 1)
    private let selectedTextColor = NSColor(srgbRed: 0.95, green: 0.95, blue: 0.95, alpha: 1)

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = backgroundColor.cgColor
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
        layer?.backgroundColor = backgroundColor.cgColor
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

        let tabWidth = min(tabMaxWidth, max(tabMinWidth, (bounds.width - 30) / CGFloat(tabs.count)))

        for (i, tab) in tabs.enumerated() {
            let x = CGFloat(i) * tabWidth
            let rect = CGRect(x: x, y: 0, width: tabWidth, height: tabHeight)

            // Tab background
            if i == selectedIndex {
                context.setFillColor(selectedTabColor.cgColor)
                context.fill(rect)
            }

            // Tab title
            let textColor = i == selectedIndex ? selectedTextColor : tabTextColor
            let font = NSFont.systemFont(ofSize: 11, weight: i == selectedIndex ? .medium : .regular)

            let paragraphStyle = NSMutableParagraphStyle()
            paragraphStyle.alignment = .center
            paragraphStyle.lineBreakMode = .byTruncatingTail

            let attrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: textColor,
                .font: font,
                .paragraphStyle: paragraphStyle,
            ]

            let title = tab.title as NSString
            let textRect = CGRect(x: x + 8, y: 6, width: tabWidth - 24, height: 16)
            title.draw(in: textRect, withAttributes: attrs)

            // Close button area (small x)
            if tabs.count > 1 {
                let closeX = x + tabWidth - 18
                let closeStr = "\u{00D7}" as NSString // ×
                let closeAttrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: tabTextColor.withAlphaComponent(0.5),
                    .font: NSFont.systemFont(ofSize: 12),
                ]
                closeStr.draw(at: CGPoint(x: closeX, y: 6), withAttributes: closeAttrs)
            }

            // Separator
            if i < tabs.count - 1 && i != selectedIndex && i != selectedIndex - 1 {
                context.setStrokeColor(NSColor(white: 0.25, alpha: 1).cgColor)
                context.setLineWidth(1)
                context.move(to: CGPoint(x: x + tabWidth, y: 4))
                context.addLine(to: CGPoint(x: x + tabWidth, y: tabHeight - 4))
                context.strokePath()
            }
        }

        // New tab button (+)
        let plusX = CGFloat(tabs.count) * tabWidth + 8
        let plusAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: tabTextColor,
            .font: NSFont.systemFont(ofSize: 14, weight: .light),
        ]
        ("+  " as NSString).draw(at: CGPoint(x: plusX, y: 5), withAttributes: plusAttrs)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let tabWidth = min(tabMaxWidth, max(tabMinWidth, (bounds.width - 30) / CGFloat(tabs.count)))

        // Check new tab button (+)
        let plusX = CGFloat(tabs.count) * tabWidth + 8
        if point.x >= plusX && point.x <= plusX + 20 {
            delegate?.tabBarDidRequestNewTab(self)
            return
        }

        let clickedIndex = Int(point.x / tabWidth)
        guard clickedIndex >= 0, clickedIndex < tabs.count else { return }

        // Check close button (small × drawn at tabWidth - 18, roughly 12px wide)
        if tabs.count > 1 {
            let closeLeft = CGFloat(clickedIndex) * tabWidth + tabWidth - 22
            let closeRight = CGFloat(clickedIndex) * tabWidth + tabWidth - 4
            if point.x >= closeLeft && point.x <= closeRight && point.y >= 2 && point.y <= 22 {
                delegate?.tabBar(self, didCloseTabAt: clickedIndex)
                return
            }
        }

        delegate?.tabBar(self, didSelectTabAt: clickedIndex)
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: tabHeight)
    }
}
