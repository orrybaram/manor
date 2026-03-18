import AppKit
import ManorCore

final class EmptyStateView: NSView {
    enum Mode {
        case noProjects
        case noTabs
    }

    var mode: Mode = .noTabs {
        didSet { needsDisplay = true }
    }
    var onNewTerminal: (() -> Void)?
    var onAddProject: (() -> Void)?

    private var bg: NSColor { GhosttyApp.shared.theme.sidebarBackground }
    private var isButtonHovered = false
    private var buttonRect: CGRect = .zero
    private var trackingArea: NSTrackingArea?

    // 5-wide × 7-tall pixel art "M"
    private let mPixels: [[Bool]] = [
        [true,  false, false, false, true ],
        [true,  true,  false, true,  true ],
        [true,  false, true,  false, true ],
        [true,  false, false, false, true ],
        [true,  false, false, false, true ],
        [true,  false, false, false, true ],
        [true,  false, false, false, true ],
    ]

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = bg.cgColor
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
        layer?.backgroundColor = bg.cgColor
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        context.setFillColor(bg.cgColor)
        context.fill(bounds)

        let cx = bounds.midX
        let cy = bounds.midY

        // --- Pixel art M logo ---
        let pixelSize: CGFloat = 9
        let pixelGap: CGFloat = 3
        let pixelStep = pixelSize + pixelGap
        let cols = mPixels[0].count
        let rows = mPixels.count
        let logoW = CGFloat(cols) * pixelStep - pixelGap
        let logoH = CGFloat(rows) * pixelStep - pixelGap
        let logoX = cx - logoW / 2
        let logoY = cy - 130

        context.setFillColor(NSColor(white: 0.38, alpha: 1).cgColor)
        for (row, rowPixels) in mPixels.enumerated() {
            for (col, filled) in rowPixels.enumerated() {
                guard filled else { continue }
                let px = logoX + CGFloat(col) * pixelStep
                let py = logoY + CGFloat(row) * pixelStep
                context.fill(CGRect(x: px, y: py, width: pixelSize, height: pixelSize))
            }
        }

        // "MANOR" wordmark below the logo
        let nameAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium),
            .foregroundColor: NSColor(white: 0.26, alpha: 1),
            .kern: 5.0 as Any,
        ]
        let nameStr = "MANOR" as NSString
        let nameSize = nameStr.size(withAttributes: nameAttrs)
        nameStr.draw(at: CGPoint(
            x: cx - nameSize.width / 2,
            y: logoY + logoH + 14
        ), withAttributes: nameAttrs)

        // --- Action button ---
        let buttonW: CGFloat = 216
        let buttonH: CGFloat = 38
        let buttonX = cx - buttonW / 2
        let buttonY = cy + 30
        buttonRect = CGRect(x: buttonX, y: buttonY, width: buttonW, height: buttonH)

        let theme = GhosttyApp.shared.theme
        let btnBg = isButtonHovered ? theme.hoverBackground : theme.selectedTabBackground

        context.setFillColor(btnBg.cgColor)
        let path = CGPath(roundedRect: buttonRect, cornerWidth: 7, cornerHeight: 7, transform: nil)
        context.addPath(path)
        context.fillPath()

        switch mode {
        case .noTabs:
            // Terminal icon ">_"
            let iconAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
                .foregroundColor: NSColor(white: 0.50, alpha: 1),
            ]
            let iconStr = ">_" as NSString
            let iconSize = iconStr.size(withAttributes: iconAttrs)
            iconStr.draw(at: CGPoint(
                x: buttonX + 14,
                y: buttonY + (buttonH - iconSize.height) / 2
            ), withAttributes: iconAttrs)

            let labelAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 13, weight: .medium),
                .foregroundColor: NSColor(white: 0.80, alpha: 1),
            ]
            let labelStr = "New Terminal" as NSString
            let labelSize = labelStr.size(withAttributes: labelAttrs)
            labelStr.draw(at: CGPoint(
                x: buttonX + 44,
                y: buttonY + (buttonH - labelSize.height) / 2
            ), withAttributes: labelAttrs)

            let kbAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor(white: 0.32, alpha: 1),
            ]
            let kbStr = "⌘T" as NSString
            let kbSize = kbStr.size(withAttributes: kbAttrs)
            kbStr.draw(at: CGPoint(
                x: buttonX + buttonW - kbSize.width - 12,
                y: buttonY + (buttonH - kbSize.height) / 2
            ), withAttributes: kbAttrs)

        case .noProjects:
            // Folder icon "⊕" or use text
            let iconAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 14, weight: .regular),
                .foregroundColor: NSColor(white: 0.50, alpha: 1),
            ]
            let iconStr = "+" as NSString
            let iconSize = iconStr.size(withAttributes: iconAttrs)
            iconStr.draw(at: CGPoint(
                x: buttonX + 14,
                y: buttonY + (buttonH - iconSize.height) / 2
            ), withAttributes: iconAttrs)

            let labelAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 13, weight: .medium),
                .foregroundColor: NSColor(white: 0.80, alpha: 1),
            ]
            let labelStr = "Add Project" as NSString
            let labelSize = labelStr.size(withAttributes: labelAttrs)
            labelStr.draw(at: CGPoint(
                x: buttonX + 34,
                y: buttonY + (buttonH - labelSize.height) / 2
            ), withAttributes: labelAttrs)

            let kbAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor(white: 0.32, alpha: 1),
            ]
            let kbStr = "⇧⌘O" as NSString
            let kbSize = kbStr.size(withAttributes: kbAttrs)
            kbStr.draw(at: CGPoint(
                x: buttonX + buttonW - kbSize.width - 12,
                y: buttonY + (buttonH - kbSize.height) / 2
            ), withAttributes: kbAttrs)
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if buttonRect.contains(point) {
            switch mode {
            case .noTabs: onNewTerminal?()
            case .noProjects: onAddProject?()
            }
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea {
            removeTrackingArea(existing)
        }
        trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(trackingArea!)
    }

    override func resetCursorRects() {
        if !buttonRect.isEmpty {
            addCursorRect(buttonRect, cursor: .pointingHand)
        }
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let hovered = buttonRect.contains(point)
        if hovered != isButtonHovered {
            isButtonHovered = hovered
            needsDisplay = true
            window?.invalidateCursorRects(for: self)
        }
    }

    override func mouseExited(with event: NSEvent) {
        if isButtonHovered {
            isButtonHovered = false
            needsDisplay = true
        }
        NSCursor.arrow.set()
    }
}
