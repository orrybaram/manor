import AppKit

// MARK: - Section Config

struct AccordionSectionConfig {
    let id: UUID
    let title: String
    /// Optional label shown right-aligned in the header (e.g. "Add +").
    let actionLabel: String?

    init(id: UUID = UUID(), title: String, actionLabel: String? = nil) {
        self.id = id
        self.title = title
        self.actionLabel = actionLabel
    }
}

// MARK: - Delegate

@MainActor protocol AccordionViewDelegate: AnyObject {
    // Data source
    func numberOfSections(in accordion: AccordionView) -> Int
    func accordion(_ accordion: AccordionView, configForSection section: Int) -> AccordionSectionConfig
    func accordion(_ accordion: AccordionView, numberOfItemsInSection section: Int) -> Int
    func accordion(_ accordion: AccordionView, heightForItemAt indexPath: IndexPath) -> CGFloat

    // Item rendering — called after the background fill (selected/hover) is already drawn.
    func accordion(_ accordion: AccordionView, drawItem context: CGContext, rect: CGRect, at indexPath: IndexPath, isHovered: Bool, isSelected: Bool)

    // Events
    func accordion(_ accordion: AccordionView, didSelectItemAt indexPath: IndexPath)

    // Optional
    func accordion(_ accordion: AccordionView, didTapHeaderActionFor section: Int)
    func accordion(_ accordion: AccordionView, didToggleSection section: Int, isExpanded: Bool)
}

extension AccordionViewDelegate {
    func accordion(_ accordion: AccordionView, didTapHeaderActionFor section: Int) {}
    func accordion(_ accordion: AccordionView, didToggleSection section: Int, isExpanded: Bool) {}
}

// MARK: - AccordionView

final class AccordionView: NSView {
    weak var delegate: AccordionViewDelegate?

    /// Which sections are currently open. Set directly or call expand/collapse helpers.
    var expandedSectionIDs: Set<UUID> = [] {
        didSet { needsDisplay = true }
    }

    var selectedIndexPath: IndexPath? {
        didSet { needsDisplay = true }
    }

    // Layout
    let sectionHeaderHeight: CGFloat = 28
    let insetX: CGFloat = 12

    // Hover state
    private var hoverRow: Row?
    private var trackingArea: NSTrackingArea?

    // Colors — derived from the active terminal theme.
    private var theme: GhosttyTheme { GhosttyApp.shared.theme }
    private var backgroundColor: NSColor { theme.sidebarBackground }
    private var hoverColor: NSColor { theme.hoverBackground }
    private var selectedColor: NSColor { theme.selectedBackground }
    private var dimTextColor: NSColor { theme.dimText }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    // MARK: - Row Model

    private enum Row: Equatable {
        case sectionHeader(sectionIndex: Int)
        case item(indexPath: IndexPath)
    }

    private func buildRows() -> [Row] {
        guard let delegate else { return [] }
        var rows: [Row] = []
        let sectionCount = delegate.numberOfSections(in: self)
        for s in 0..<sectionCount {
            rows.append(.sectionHeader(sectionIndex: s))
            let config = delegate.accordion(self, configForSection: s)
            guard expandedSectionIDs.contains(config.id) else { continue }
            let itemCount = delegate.accordion(self, numberOfItemsInSection: s)
            for i in 0..<itemCount {
                rows.append(.item(indexPath: IndexPath(item: i, section: s)))
            }
        }
        return rows
    }

    private func height(for row: Row) -> CGFloat {
        switch row {
        case .sectionHeader:
            return sectionHeaderHeight
        case .item(let indexPath):
            return delegate?.accordion(self, heightForItemAt: indexPath) ?? 26
        }
    }

    private func yPositions(for rows: [Row]) -> [CGFloat] {
        var positions: [CGFloat] = []
        var y: CGFloat = 0
        for row in rows {
            positions.append(y)
            y += height(for: row)
        }
        return positions
    }

    private func rowIndex(for point: CGPoint, in rows: [Row]) -> Int? {
        let positions = yPositions(for: rows)
        for (i, (row, yPos)) in zip(rows, positions).enumerated() {
            let h = height(for: row)
            if point.y >= yPos && point.y < yPos + h { return i }
        }
        return nil
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        context.setFillColor(backgroundColor.cgColor)
        context.fill(bounds)

        let rows = buildRows()
        let positions = yPositions(for: rows)

        for (i, row) in rows.enumerated() {
            let y = positions[i]
            let h = height(for: row)
            let rect = CGRect(x: 0, y: y, width: bounds.width, height: h)
            let isHovered = hoverRow == row

            switch row {
            case .sectionHeader(let sectionIndex):
                drawSectionHeader(context: context, sectionIndex: sectionIndex, rect: rect, isHovered: isHovered)
            case .item(let indexPath):
                let isSelected = selectedIndexPath == indexPath
                if isSelected {
                    context.setFillColor(selectedColor.cgColor)
                    context.fill(rect)
                } else if isHovered {
                    context.setFillColor(hoverColor.cgColor)
                    context.fill(rect)
                }
                delegate?.accordion(self, drawItem: context, rect: rect, at: indexPath, isHovered: isHovered, isSelected: isSelected)
            }
        }
    }

    private func drawSectionHeader(context: CGContext, sectionIndex: Int, rect: CGRect, isHovered: Bool) {
        guard let delegate else { return }
        let config = delegate.accordion(self, configForSection: sectionIndex)
        let isExpanded = expandedSectionIDs.contains(config.id)
        let hasItems = delegate.accordion(self, numberOfItemsInSection: sectionIndex) > 0

        if isHovered {
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        let headerAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dimTextColor,
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        let textMidY = rect.minY + (rect.height - 12) / 2

        // Chevron (only when section has items)
        if hasItems {
            let symbolName = isExpanded ? "chevron.down" : "chevron.right"
            if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
                let cfg = NSImage.SymbolConfiguration(pointSize: 9, weight: .medium)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [dimTextColor]))
                let sized = img.withSymbolConfiguration(cfg) ?? img
                let iw = sized.size.width, ih = sized.size.height
                let imgRect = CGRect(x: 3, y: rect.minY + (rect.height - ih) / 2, width: iw, height: ih)
                sized.draw(in: imgRect, from: .zero, operation: .sourceOver, fraction: 1,
                           respectFlipped: true,
                           hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            }
        }

        // Title
        (config.title as NSString).draw(at: CGPoint(x: insetX, y: textMidY), withAttributes: headerAttrs)

        // Action label (right-aligned)
        if let actionLabel = config.actionLabel {
            let actionSize = (actionLabel as NSString).size(withAttributes: headerAttrs)
            let actionX = bounds.width - actionSize.width - insetX
            (actionLabel as NSString).draw(at: CGPoint(x: actionX, y: textMidY), withAttributes: headerAttrs)
        }
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let rows = buildRows()
        guard let idx = rowIndex(for: point, in: rows) else { return }
        let row = rows[idx]

        switch row {
        case .sectionHeader(let sectionIndex):
            guard let delegate else { return }
            let config = delegate.accordion(self, configForSection: sectionIndex)
            let hasItems = delegate.accordion(self, numberOfItemsInSection: sectionIndex) > 0

            // Check action button hit area
            if let actionLabel = config.actionLabel {
                let headerAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]
                let actionSize = (actionLabel as NSString).size(withAttributes: headerAttrs)
                let actionX = bounds.width - actionSize.width - insetX - 4
                if point.x >= actionX {
                    delegate.accordion(self, didTapHeaderActionFor: sectionIndex)
                    return
                }
            }

            if hasItems { toggleSection(sectionIndex) }

        case .item(let indexPath):
            selectedIndexPath = indexPath
            delegate?.accordion(self, didSelectItemAt: indexPath)
        }
    }

    private func toggleSection(_ sectionIndex: Int) {
        guard let delegate else { return }
        let config = delegate.accordion(self, configForSection: sectionIndex)
        let wasExpanded = expandedSectionIDs.contains(config.id)
        if wasExpanded {
            expandedSectionIDs.remove(config.id)
        } else {
            expandedSectionIDs.insert(config.id)
        }
        delegate.accordion(self, didToggleSection: sectionIndex, isExpanded: !wasExpanded)
    }

    // MARK: - Hover Tracking

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea { removeTrackingArea(existing) }
        trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(trackingArea!)
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let rows = buildRows()
        let newHover = rowIndex(for: point, in: rows).map { rows[$0] }
        if newHover != hoverRow {
            hoverRow = newHover
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        if hoverRow != nil {
            hoverRow = nil
            needsDisplay = true
        }
    }

    override func resetCursorRects() {
        let rows = buildRows()
        let positions = yPositions(for: rows)
        for (i, row) in rows.enumerated() {
            let y = positions[i]
            let h = height(for: row)
            addCursorRect(CGRect(x: 0, y: y, width: bounds.width, height: h), cursor: .pointingHand)
        }
    }

    // MARK: - Public API

    func reloadData() {
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
    }

    func expandSection(withID id: UUID) {
        expandedSectionIDs.insert(id)
    }

    func collapseSection(withID id: UUID) {
        expandedSectionIDs.remove(id)
    }

    func expandAllSections() {
        guard let delegate else { return }
        let count = delegate.numberOfSections(in: self)
        for s in 0..<count {
            let config = delegate.accordion(self, configForSection: s)
            expandedSectionIDs.insert(config.id)
        }
    }
}
