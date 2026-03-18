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
    // MARK: Required
    func numberOfSections(in accordion: AccordionView) -> Int
    func accordion(_ accordion: AccordionView, configForSection section: Int) -> AccordionSectionConfig
    func accordion(_ accordion: AccordionView, numberOfItemsInSection section: Int) -> Int
    func accordion(_ accordion: AccordionView, heightForItemAt indexPath: IndexPath) -> CGFloat
    func accordion(_ accordion: AccordionView, drawItem context: CGContext, rect: CGRect, at indexPath: IndexPath, isHovered: Bool, isSelected: Bool)
    func accordion(_ accordion: AccordionView, didClickItem indexPath: IndexPath, localPoint: CGPoint, in rect: CGRect, event: NSEvent)

    // MARK: Optional — section header
    func accordion(_ accordion: AccordionView, heightForSection section: Int) -> CGFloat
    func accordion(_ accordion: AccordionView, drawSectionHeader context: CGContext, rect: CGRect, for section: Int, isHovered: Bool, isExpanded: Bool, isSelected: Bool)

    // MARK: Optional — section interaction
    /// Return false to suppress the accordion's built-in toggle-on-click; use didTapSection to handle manually.
    func accordion(_ accordion: AccordionView, shouldToggleSection section: Int) -> Bool
    func accordion(_ accordion: AccordionView, didTapSection section: Int, localPoint: CGPoint, event: NSEvent)
    func accordion(_ accordion: AccordionView, didTapHeaderActionFor section: Int)

    // MARK: Optional — right-click
    func accordion(_ accordion: AccordionView, didRightClickSection section: Int, with event: NSEvent)
    func accordion(_ accordion: AccordionView, didRightClickItem indexPath: IndexPath, with event: NSEvent)

    // MARK: Optional — double-click
    func accordion(_ accordion: AccordionView, didDoubleClickItem indexPath: IndexPath)

    // MARK: Optional — layout callbacks
    func accordionDidChangeContentHeight(_ accordion: AccordionView)

    // MARK: Optional — scroll: return a max visible height to clip and scroll items in that section
    func accordion(_ accordion: AccordionView, maxVisibleItemsHeightForSection section: Int) -> CGFloat?
}

extension AccordionViewDelegate {
    func accordion(_ accordion: AccordionView, heightForSection section: Int) -> CGFloat {
        accordion.sectionHeaderHeight
    }
    func accordion(_ accordion: AccordionView, drawSectionHeader context: CGContext, rect: CGRect, for section: Int, isHovered: Bool, isExpanded: Bool, isSelected: Bool) {
        accordion.defaultDrawSectionHeader(context: context, rect: rect, for: section, isHovered: isHovered, isExpanded: isExpanded)
    }
    func accordion(_ accordion: AccordionView, shouldToggleSection section: Int) -> Bool { true }
    func accordion(_ accordion: AccordionView, didTapSection section: Int, localPoint: CGPoint, event: NSEvent) {}
    func accordion(_ accordion: AccordionView, didTapHeaderActionFor section: Int) {}
    func accordion(_ accordion: AccordionView, didRightClickSection section: Int, with event: NSEvent) {}
    func accordion(_ accordion: AccordionView, didRightClickItem indexPath: IndexPath, with event: NSEvent) {}
    func accordion(_ accordion: AccordionView, didDoubleClickItem indexPath: IndexPath) {}
    func accordionDidChangeContentHeight(_ accordion: AccordionView) {}
    func accordion(_ accordion: AccordionView, maxVisibleItemsHeightForSection section: Int) -> CGFloat? { nil }
}

// MARK: - AccordionView

final class AccordionView: NSView {
    weak var delegate: AccordionViewDelegate? {
        didSet { reloadData() }
    }

    var expandedSectionIDs: Set<UUID> = [] {
        didSet {
            needsDisplay = true
            window?.invalidateCursorRects(for: self)
            delegate?.accordionDidChangeContentHeight(self)
        }
    }

    var selectedIndexPath: IndexPath? {
        didSet { needsDisplay = true }
    }

    /// Section-level selection (highlights the header row of a section).
    var selectedSection: Int? {
        didSet { needsDisplay = true }
    }

    /// Per-section scroll offsets for sections with a `maxVisibleItemsHeight` constraint.
    var sectionScrollOffsets: [Int: CGFloat] = [:] {
        didSet { needsDisplay = true }
    }

    // MARK: - Animation

    /// Visual expansion progress per section ID: 0 = fully collapsed, 1 = fully expanded.
    private var expansionProgress: [UUID: CGFloat] = [:]
    private var animationTimer: Timer?

    private func startAnimationIfNeeded() {
        guard animationTimer == nil else { return }
        animationTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.animationStep()
        }
    }

    private func animationStep() {
        let factor: CGFloat = 0.2
        var allSettled = true

        let activeIDs = Set(expandedSectionIDs).union(expansionProgress.keys)
        for id in activeIDs {
            let target: CGFloat = expandedSectionIDs.contains(id) ? 1 : 0
            let current = expansionProgress[id] ?? target
            let next = current + (target - current) * factor
            if abs(next - target) < 0.004 {
                expansionProgress[id] = target
                if target == 0 { expansionProgress.removeValue(forKey: id) }
            } else {
                expansionProgress[id] = next
                allSettled = false
            }
        }

        needsDisplay = true
        window?.invalidateCursorRects(for: self)
        delegate?.accordionDidChangeContentHeight(self)

        if allSettled {
            animationTimer?.invalidate()
            animationTimer = nil
        }
    }

    // Layout
    let sectionHeaderHeight: CGFloat = 28
    let insetX: CGFloat = 12

    // Hover state
    private var hoverRow: HoveredRow?
    private var trackingArea: NSTrackingArea?

    // Colors
    private var theme: GhosttyTheme { GhosttyApp.shared.theme }
    private var backgroundColor: NSColor { theme.sidebarBackground }
    private var hoverColor: NSColor { theme.hoverBackground }
    private var selectedColor: NSColor { theme.selectedBackground }
    private var dimTextColor: NSColor { theme.dimText }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    // MARK: - Internal Types

    private enum HoveredRow: Equatable {
        case section(Int)
        case item(IndexPath)
    }

    private struct ItemLayout {
        let indexPath: IndexPath
        let logicalY: CGFloat
        let height: CGFloat
    }

    private struct SectionLayout {
        let index: Int
        let config: AccordionSectionConfig
        let headerY: CGFloat
        let headerHeight: CGFloat
        let isExpanded: Bool
        let items: [ItemLayout]
        let scrollOffset: CGFloat
        let maxVisibleItemsHeight: CGFloat?
        let expansionProgress: CGFloat

        var totalItemsHeight: CGFloat { items.reduce(0) { $0 + $1.height } }

        var visibleItemsHeight: CGFloat {
            guard expansionProgress > 0 else { return 0 }
            let full = maxVisibleItemsHeight.map { min($0, totalItemsHeight) } ?? totalItemsHeight
            return full * expansionProgress
        }

        var totalHeight: CGFloat { headerHeight + visibleItemsHeight }
        var itemsTopY: CGFloat { headerY + headerHeight }
    }

    // MARK: - Layout Model

    private func buildSections() -> [SectionLayout] {
        guard let delegate else { return [] }
        var layouts: [SectionLayout] = []
        var y: CGFloat = 0
        let count = delegate.numberOfSections(in: self)

        for s in 0..<count {
            let config = delegate.accordion(self, configForSection: s)
            let hh = delegate.accordion(self, heightForSection: s)
            let headerY = y
            y += hh

            let isExpanded = expandedSectionIDs.contains(config.id)
            let progress = expansionProgress[config.id] ?? (isExpanded ? 1.0 : 0.0)
            let hasVisibleItems = progress > 0

            var items: [ItemLayout] = []

            if hasVisibleItems {
                let itemCount = delegate.accordion(self, numberOfItemsInSection: s)
                var itemY = y
                for i in 0..<itemCount {
                    let ip = IndexPath(item: i, section: s)
                    let ih = delegate.accordion(self, heightForItemAt: ip)
                    items.append(ItemLayout(indexPath: ip, logicalY: itemY, height: ih))
                    itemY += ih
                }
                let maxH = delegate.accordion(self, maxVisibleItemsHeightForSection: s)
                let totalItemsH = items.reduce(0) { $0 + $1.height }
                let fullVisibleH = maxH.map { min($0, totalItemsH) } ?? totalItemsH
                y += fullVisibleH * progress
                layouts.append(SectionLayout(
                    index: s, config: config, headerY: headerY, headerHeight: hh,
                    isExpanded: isExpanded, items: items,
                    scrollOffset: sectionScrollOffsets[s] ?? 0, maxVisibleItemsHeight: maxH,
                    expansionProgress: progress
                ))
            } else {
                layouts.append(SectionLayout(
                    index: s, config: config, headerY: headerY, headerHeight: hh,
                    isExpanded: false, items: [], scrollOffset: 0, maxVisibleItemsHeight: nil,
                    expansionProgress: 0
                ))
            }
        }
        return layouts
    }

    // MARK: - Hit Testing

    private func hitTest(point: CGPoint, sections: [SectionLayout]) -> HoveredRow? {
        for section in sections {
            let headerRect = CGRect(x: 0, y: section.headerY, width: bounds.width, height: section.headerHeight)
            if headerRect.contains(point) { return .section(section.index) }

            guard section.isExpanded else { continue }
            let itemsTop = section.itemsTopY
            let visibleH = section.visibleItemsHeight
            guard point.y >= itemsTop && point.y < itemsTop + visibleH else { continue }

            for item in section.items {
                let renderedY = item.logicalY - section.scrollOffset
                if point.y >= renderedY && point.y < renderedY + item.height {
                    return .item(item.indexPath)
                }
            }
        }
        return nil
    }

    // MARK: - Public Helpers

    var totalContentHeight: CGFloat {
        buildSections().reduce(0) { $0 + $1.totalHeight }
    }

    func yPosition(forSection section: Int) -> CGFloat? {
        buildSections().first(where: { $0.index == section })?.headerY
    }

    func yPosition(forItem at: IndexPath) -> CGFloat? {
        let sections = buildSections()
        guard let section = sections.first(where: { $0.index == at.section }),
              let item = section.items.first(where: { $0.indexPath == at }) else { return nil }
        return item.logicalY - section.scrollOffset
    }

    func toggle(section: Int) {
        guard let delegate else { return }
        let config = delegate.accordion(self, configForSection: section)
        if expandedSectionIDs.contains(config.id) {
            expandedSectionIDs.remove(config.id)
        } else {
            if expansionProgress[config.id] == nil { expansionProgress[config.id] = 0 }
            expandedSectionIDs.insert(config.id)
        }
        startAnimationIfNeeded()
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext, let delegate else { return }

        let sections = buildSections()

        for section in sections {
            let headerRect = CGRect(x: 0, y: section.headerY, width: bounds.width, height: section.headerHeight)
            let isHovered = hoverRow == .section(section.index)
            let isSelected = selectedSection == section.index
            delegate.accordion(self, drawSectionHeader: context, rect: headerRect, for: section.index,
                               isHovered: isHovered, isExpanded: section.isExpanded, isSelected: isSelected)

            guard section.isExpanded, !section.items.isEmpty else { continue }

            let itemsTop = section.itemsTopY
            let visibleH = section.visibleItemsHeight
            let needsClip = section.maxVisibleItemsHeight != nil || section.expansionProgress < 1

            if needsClip {
                context.saveGState()
                context.clip(to: CGRect(x: 0, y: itemsTop, width: bounds.width, height: visibleH))
            }

            for item in section.items {
                let renderedY = item.logicalY - section.scrollOffset
                if needsClip && (renderedY + item.height <= itemsTop || renderedY >= itemsTop + visibleH) { continue }

                let rect = CGRect(x: 0, y: renderedY, width: bounds.width, height: item.height)
                let isItemHovered = hoverRow == .item(item.indexPath)
                let isItemSelected = selectedIndexPath == item.indexPath

                if isItemSelected {
                    context.setFillColor(selectedColor.cgColor)
                    context.fill(rect)
                } else if isItemHovered {
                    context.setFillColor(hoverColor.cgColor)
                    context.fill(rect)
                }

                delegate.accordion(self, drawItem: context, rect: rect, at: item.indexPath,
                                   isHovered: isItemHovered, isSelected: isItemSelected)
            }

            if needsClip { context.restoreGState() }
        }
    }

    /// Default section header renderer — called by the protocol extension default implementation.
    /// Draws: hover background, chevron (when has items), title, optional right-side action label.
    func defaultDrawSectionHeader(context: CGContext, rect: CGRect, for section: Int, isHovered: Bool, isExpanded: Bool) {
        guard let delegate else { return }
        let config = delegate.accordion(self, configForSection: section)
        let hasItems = delegate.accordion(self, numberOfItemsInSection: section) > 0

        if isHovered {
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        let textMidY = rect.minY + (rect.height - 12) / 2
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dimTextColor,
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]

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

        (config.title as NSString).draw(at: CGPoint(x: insetX, y: textMidY), withAttributes: headerAttrs)

        if let actionLabel = config.actionLabel {
            let actionSize = (actionLabel as NSString).size(withAttributes: headerAttrs)
            (actionLabel as NSString).draw(
                at: CGPoint(x: bounds.width - actionSize.width - insetX, y: textMidY),
                withAttributes: headerAttrs
            )
        }
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let sections = buildSections()
        guard let hit = hitTest(point: point, sections: sections) else { return }

        switch hit {
        case .section(let sectionIndex):
            // Action label hit area
            if let config = sections.first(where: { $0.index == sectionIndex })?.config,
               let actionLabel = config.actionLabel {
                let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]
                let size = (actionLabel as NSString).size(withAttributes: attrs)
                if point.x >= bounds.width - size.width - insetX - 4 {
                    delegate?.accordion(self, didTapHeaderActionFor: sectionIndex)
                    return
                }
            }
            let itemCount = delegate?.accordion(self, numberOfItemsInSection: sectionIndex) ?? 0
            let shouldToggle = delegate?.accordion(self, shouldToggleSection: sectionIndex) ?? true
            if shouldToggle && itemCount > 0 { toggle(section: sectionIndex) }
            delegate?.accordion(self, didTapSection: sectionIndex, localPoint: point, event: event)

        case .item(let indexPath):
            guard let section = sections.first(where: { $0.index == indexPath.section }),
                  let item = section.items.first(where: { $0.indexPath == indexPath }) else { return }
            let renderedY = item.logicalY - section.scrollOffset
            let rect = CGRect(x: 0, y: renderedY, width: bounds.width, height: item.height)

            if event.clickCount == 2 {
                delegate?.accordion(self, didDoubleClickItem: indexPath)
            } else {
                delegate?.accordion(self, didClickItem: indexPath, localPoint: point, in: rect, event: event)
            }
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let sections = buildSections()
        switch hitTest(point: point, sections: sections) {
        case .section(let s): delegate?.accordion(self, didRightClickSection: s, with: event)
        case .item(let ip): delegate?.accordion(self, didRightClickItem: ip, with: event)
        case nil: break
        }
    }

    // MARK: - Scroll

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let sections = buildSections()

        for section in sections {
            guard section.isExpanded, let maxH = section.maxVisibleItemsHeight else { continue }
            let itemsTop = section.itemsTopY
            guard point.y >= itemsTop && point.y < itemsTop + maxH else { continue }

            let rowH = section.items.first?.height ?? 22
            let delta = event.scrollingDeltaY * (event.hasPreciseScrollingDeltas ? 1 : rowH)
            let current = sectionScrollOffsets[section.index] ?? 0
            let maxOffset = max(0, section.totalItemsHeight - maxH)
            sectionScrollOffsets[section.index] = max(0, min(maxOffset, current - delta))
            needsDisplay = true
            return
        }

        super.scrollWheel(with: event)
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
        let newHover = hitTest(point: point, sections: buildSections())
        if newHover != hoverRow {
            hoverRow = newHover
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        if hoverRow != nil { hoverRow = nil; needsDisplay = true }
    }

    override func resetCursorRects() {
        let sections = buildSections()
        for section in sections {
            addCursorRect(
                CGRect(x: 0, y: section.headerY, width: bounds.width, height: section.headerHeight),
                cursor: .pointingHand
            )
            guard section.isExpanded else { continue }
            let itemsTop = section.itemsTopY
            let visibleH = section.visibleItemsHeight
            for item in section.items {
                let renderedY = item.logicalY - section.scrollOffset
                guard renderedY + item.height > itemsTop && renderedY < itemsTop + visibleH else { continue }
                let top = max(renderedY, itemsTop)
                let bottom = min(renderedY + item.height, itemsTop + visibleH)
                addCursorRect(CGRect(x: 0, y: top, width: bounds.width, height: bottom - top), cursor: .pointingHand)
            }
        }
    }

    // MARK: - Public API

    func reloadData() {
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
        delegate?.accordionDidChangeContentHeight(self)
    }

    func expandSection(withID id: UUID) {
        if expansionProgress[id] == nil { expansionProgress[id] = 0 }
        expandedSectionIDs.insert(id)
        startAnimationIfNeeded()
    }

    func collapseSection(withID id: UUID) {
        expandedSectionIDs.remove(id)
        startAnimationIfNeeded()
    }

    func expandAllSections() {
        guard let delegate else { return }
        let count = delegate.numberOfSections(in: self)
        for s in 0..<count {
            let id = delegate.accordion(self, configForSection: s).id
            if expansionProgress[id] == nil { expansionProgress[id] = 0 }
            expandedSectionIDs.insert(id)
        }
        startAnimationIfNeeded()
    }
}
