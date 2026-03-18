import AppKit
import ManorCore

// MARK: - Worktree View Item

struct WorktreeViewItem {
    let info: WorktreeInfo
    let label: String
    let hasRunCommand: Bool
    var prInfo: GitHubPRInfo?
    var diffStat: DiffStat?
}

// MARK: - Delegate

@MainActor protocol ProjectSidebarDelegate: AnyObject {
    func sidebar(_ sidebar: ProjectSidebarView, didSelectProject index: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didSelectWorktree worktree: WorktreeInfo, inProject index: Int)
    func sidebarDidRequestAddProject(_ sidebar: ProjectSidebarView)
    func sidebar(_ sidebar: ProjectSidebarView, didRequestRemoveProject index: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didClickPort port: ActivePort)
    func sidebar(_ sidebar: ProjectSidebarView, didClickPortWorktreeFor port: ActivePort)
    // Worktree management
    func sidebar(_ sidebar: ProjectSidebarView, didRequestCreateWorktree inProject: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didRequestDeleteWorktree worktree: WorktreeInfo, inProject: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didRenameWorktree worktree: WorktreeInfo, newName: String, inProject: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didRequestRunCommand worktree: WorktreeInfo, inProject: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didRequestProjectSettings index: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didRequestCheckoutDefaultBranch inProject: Int)
}

// MARK: - Sidebar View

final class ProjectSidebarView: NSView {
    weak var delegate: ProjectSidebarDelegate?

    var projects: [(id: UUID, name: String, worktrees: [WorktreeViewItem], selectedWorktreePath: String?)] = [] {
        didSet {
            let oldIDs = Set(oldValue.map { $0.id })
            for project in projects where !oldIDs.contains(project.id) {
                projectsAccordion.expandSection(withID: project.id)
            }
            updateAccordionSelection()
            projectsAccordion.reloadData()
            portsAccordion.reloadData()  // port rows show worktree labels
            needsLayout = true
        }
    }

    var selectedProjectIndex: Int = 0 {
        didSet {
            if selectedProjectIndex != oldValue, selectedProjectIndex < projects.count {
                let project = projects[selectedProjectIndex]
                if !project.worktrees.isEmpty { projectsAccordion.expandSection(withID: project.id) }
            }
            updateAccordionSelection()
            needsLayout = true
        }
    }

    var expandedProjectIDs: Set<UUID> {
        get { projectsAccordion.expandedSectionIDs }
        set { projectsAccordion.expandedSectionIDs = newValue }
    }

    var activePorts: [ActivePort] = [] {
        didSet {
            portsAccordion.reloadData()
            portsAccordion.isHidden = activePorts.isEmpty
            needsLayout = true
            needsDisplay = true
        }
    }

    var isPortsSectionExpanded: Bool {
        get { portsAccordion.expandedSectionIDs.contains(portsID) }
        set {
            if newValue { portsAccordion.expandSection(withID: portsID) }
            else { portsAccordion.collapseSection(withID: portsID) }
            needsLayout = true
        }
    }

    // Layout constants
    private let rowHeight: CGFloat = 26
    private let worktreeRowHeight: CGFloat = 22
    private let projectInsetX: CGFloat = 12
    private let worktreeInsetX: CGFloat = 28
    private let trafficLightPadding: CGFloat = 28
    private let headerHeight: CGFloat = 36
    private let portRowHeight: CGFloat = 22
    private let portsSectionHeaderHeight: CGFloat = 28
    private let portsSectionPadding: CGFloat = 8

    // Resize
    static let widthKey = "sidebarWidth"
    static let defaultWidth: CGFloat = 180
    static let minWidth: CGFloat = 120
    static let maxWidth: CGFloat = 300
    private let resizeHandleWidth: CGFloat = 5

    private var isResizing = false
    private var resizeStartX: CGFloat = 0
    private var resizeStartWidth: CGFloat = 0
    var widthConstraintRef: NSLayoutConstraint?
    var onWidthChanged: ((CGFloat) -> Void)?

    // Subviews
    private let projectsAccordion = AccordionView()
    private let portsAccordion = AccordionView()

    // Stable ID for the single PORTS section
    private let portsID = UUID()

    // Rename overlay
    private struct RenameState {
        let projectIndex: Int
        let item: WorktreeViewItem
        let textField: NSTextField
    }
    private var renameState: RenameState?
    private var renameEventMonitor: Any?

    // Colors
    private var theme: GhosttyTheme { GhosttyApp.shared.theme }
    private var backgroundColor: NSColor { theme.sidebarBackground }
    private var selectedColor: NSColor { theme.selectedBackground }
    private var hoverColor: NSColor { theme.hoverBackground }
    private var textColor: NSColor { theme.primaryText }
    private var selectedTextColor: NSColor { theme.selectedText }
    private var dimTextColor: NSColor { theme.dimText }
    private var dividerColor: NSColor { theme.dividerColor }
    private var uncheckedColor: NSColor { theme.dimText.withAlphaComponent(0.5) }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame: NSRect) { super.init(frame: frame); setup() }
    required init?(coder: NSCoder) { super.init(coder: coder); setup() }

    private func setup() {
        wantsLayer = true
        layer?.backgroundColor = backgroundColor.cgColor

        projectsAccordion.delegate = self
        projectsAccordion.wantsLayer = true
        projectsAccordion.layer?.backgroundColor = NSColor.clear.cgColor
        addSubview(projectsAccordion)

        portsAccordion.delegate = self
        portsAccordion.wantsLayer = true
        portsAccordion.layer?.backgroundColor = NSColor.clear.cgColor
        portsAccordion.isHidden = true
        portsAccordion.expandSection(withID: portsID)
        addSubview(portsAccordion)

        renameEventMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self, self.renameState != nil else { return event }
            let point = self.convert(event.locationInWindow, from: nil)
            if let tf = self.renameState?.textField, !tf.frame.contains(point) {
                self.commitRename()
            }
            return event
        }
    }

    deinit {
        if let monitor = renameEventMonitor { NSEvent.removeMonitor(monitor) }
    }

    // MARK: - Helpers

    private func sortedWorktrees(forProject index: Int) -> [WorktreeViewItem] {
        guard index < projects.count else { return [] }
        return projects[index].worktrees.sorted { $0.info.isMain && !$1.info.isMain }
    }

    private func updateAccordionSelection() {
        projectsAccordion.selectedSection = selectedProjectIndex

        guard selectedProjectIndex < projects.count else {
            projectsAccordion.selectedIndexPath = nil
            return
        }
        let project = projects[selectedProjectIndex]
        guard project.worktrees.count > 1 else {
            projectsAccordion.selectedIndexPath = nil
            return
        }
        let sorted = sortedWorktrees(forProject: selectedProjectIndex)
        if let idx = sorted.firstIndex(where: { $0.info.path == project.selectedWorktreePath }) {
            projectsAccordion.selectedIndexPath = IndexPath(item: idx, section: selectedProjectIndex)
        } else {
            projectsAccordion.selectedIndexPath = nil
        }
    }

    /// The maximum height available to show port rows (used by the accordion delegate and layout).
    private var portsMaxVisibleItemsHeight: CGFloat {
        guard !activePorts.isEmpty, isPortsSectionExpanded else { return 0 }
        let topInset = trafficLightPadding + headerHeight
        let projectsBottom = topInset + projectsAccordion.totalContentHeight + portsSectionPadding
        let available = max(0, bounds.height - portsSectionPadding - portsSectionHeaderHeight - projectsBottom)
        let contentH = CGFloat(activePorts.count) * portRowHeight
        return min(contentH, min(bounds.height * 0.5, available))
    }

    // MARK: - Layout

    override func layout() {
        super.layout()
        layoutAccordions()
    }

    private func layoutAccordions() {
        let w = max(0, bounds.width - resizeHandleWidth)
        let topInset = trafficLightPadding + headerHeight

        let projectsH = projectsAccordion.totalContentHeight
        projectsAccordion.frame = CGRect(x: 0, y: topInset, width: w, height: max(projectsH, 0))

        guard !activePorts.isEmpty else { return }

        let visiblePortsH = portsMaxVisibleItemsHeight
        let portsH = portsSectionHeaderHeight + visiblePortsH
        let fromBottom = bounds.height - portsH - portsSectionPadding
        let minPortsY = topInset + projectsH + portsSectionPadding
        let portsY = max(fromBottom, minPortsY)
        portsAccordion.frame = CGRect(x: 0, y: portsY, width: w, height: portsH)

        needsDisplay = true  // redraw divider at updated position
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        context.setFillColor(backgroundColor.cgColor)
        context.fill(bounds)

        // Static "PROJECTS" header
        let contentTop = trafficLightPadding
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dimTextColor,
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        ("PROJECTS" as NSString).draw(at: CGPoint(x: projectInsetX, y: contentTop + 14), withAttributes: headerAttrs)
        let addSize = ("Add +" as NSString).size(withAttributes: headerAttrs)
        ("Add +" as NSString).draw(
            at: CGPoint(x: bounds.width - addSize.width - projectInsetX, y: contentTop + 14),
            withAttributes: headerAttrs
        )

        // Divider above ports
        if !activePorts.isEmpty, !portsAccordion.isHidden {
            let dividerY = portsAccordion.frame.minY - portsSectionPadding
            context.setFillColor(dividerColor.cgColor)
            context.fill(CGRect(x: 0, y: dividerY, width: bounds.width - 1, height: 1))
        }

        // Right-edge divider
        context.setFillColor(dividerColor.cgColor)
        context.fill(CGRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height))
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)

        // Resize handle — must check before subview hit testing
        if point.x >= bounds.width - resizeHandleWidth {
            isResizing = true
            resizeStartX = point.x
            resizeStartWidth = bounds.width
            return
        }

        // Header "Add +" button
        let contentTop = trafficLightPadding
        if point.y >= contentTop && point.y <= contentTop + headerHeight {
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]
            let addSize = ("Add +" as NSString).size(withAttributes: attrs)
            let addX = bounds.width - addSize.width - projectInsetX - 4
            if point.x >= addX {
                delegate?.sidebarDidRequestAddProject(self)
            }
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard isResizing else { return }
        let point = convert(event.locationInWindow, from: nil)
        let delta = point.x - resizeStartX
        let newWidth = max(Self.minWidth, min(Self.maxWidth, resizeStartWidth + delta))
        widthConstraintRef?.constant = newWidth
        onWidthChanged?(newWidth)
    }

    override func mouseUp(with event: NSEvent) {
        if isResizing {
            isResizing = false
            if let width = widthConstraintRef?.constant {
                UserDefaults.standard.set(width, forKey: Self.widthKey)
            }
        }
    }

    // MARK: - Cursor Rects

    override func resetCursorRects() {
        addCursorRect(
            CGRect(x: bounds.width - resizeHandleWidth, y: 0, width: resizeHandleWidth, height: bounds.height),
            cursor: .resizeLeftRight
        )
        let contentTop = trafficLightPadding
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]
        let addSize = ("Add +" as NSString).size(withAttributes: attrs)
        let addX = bounds.width - addSize.width - projectInsetX - 4
        addCursorRect(CGRect(x: addX, y: contentTop, width: bounds.width - addX, height: headerHeight), cursor: .pointingHand)
    }

    // MARK: - Inline Rename

    private func beginRename(projectIndex: Int, item: WorktreeViewItem, rowY: CGFloat) {
        cancelRename()

        let tf = NSTextField(frame: CGRect(
            x: worktreeInsetX,
            y: rowY + 3,
            width: bounds.width - worktreeInsetX - 12,
            height: rowHeight - 6
        ))
        tf.stringValue = item.label
        tf.font = NSFont.systemFont(ofSize: 11)
        tf.textColor = textColor
        tf.backgroundColor = selectedColor
        tf.isBordered = false
        tf.focusRingType = .none
        tf.cell?.wraps = false
        tf.cell?.isScrollable = true
        tf.delegate = self
        tf.tag = 9999

        addSubview(tf)
        window?.makeFirstResponder(tf)
        tf.selectText(nil)

        renameState = RenameState(projectIndex: projectIndex, item: item, textField: tf)
        needsDisplay = true
    }

    private func commitRename() {
        guard let state = renameState else { return }
        let newName = state.textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        state.textField.removeFromSuperview()
        renameState = nil
        needsDisplay = true
        if !newName.isEmpty && newName != state.item.label {
            delegate?.sidebar(self, didRenameWorktree: state.item.info, newName: newName, inProject: state.projectIndex)
        }
    }

    private func cancelRename() {
        guard let state = renameState else { return }
        state.textField.removeFromSuperview()
        renameState = nil
        needsDisplay = true
    }

    // MARK: - Port Helpers

    private func branchName(for worktreePath: String) -> String? {
        for project in projects {
            if let item = project.worktrees.first(where: { $0.info.path == worktreePath }) {
                return item.label
            }
        }
        return nil
    }

    private func worktreeLabelRect(for port: ActivePort, in rect: CGRect) -> CGRect? {
        guard let path = port.worktreePath, let branch = branchName(for: path) else { return nil }
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 9)]
        let size = (branch as NSString).size(withAttributes: attrs)
        let labelX = rect.width - size.width - 10
        return CGRect(x: labelX, y: rect.minY + 5, width: size.width + 2, height: 12)
    }
}

// MARK: - AccordionViewDelegate

extension ProjectSidebarView: AccordionViewDelegate {

    // MARK: Sections

    func numberOfSections(in accordion: AccordionView) -> Int {
        if accordion === projectsAccordion { return projects.count }
        return 1  // portsAccordion always has one section
    }

    func accordion(_ accordion: AccordionView, configForSection section: Int) -> AccordionSectionConfig {
        if accordion === projectsAccordion {
            let project = projects[section]
            return AccordionSectionConfig(id: project.id, title: project.name)
        }
        return AccordionSectionConfig(id: portsID, title: "PORTS")
    }

    func accordion(_ accordion: AccordionView, numberOfItemsInSection section: Int) -> Int {
        if accordion === projectsAccordion {
            guard section < projects.count else { return 0 }
            return projects[section].worktrees.count
        }
        return activePorts.count
    }

    func accordion(_ accordion: AccordionView, heightForSection section: Int) -> CGFloat {
        if accordion === projectsAccordion { return rowHeight }
        return portsSectionHeaderHeight
    }

    func accordion(_ accordion: AccordionView, heightForItemAt indexPath: IndexPath) -> CGFloat {
        if accordion === projectsAccordion { return worktreeRowHeight }
        return portRowHeight
    }

    // MARK: Section Header Drawing

    func accordion(_ accordion: AccordionView, drawSectionHeader context: CGContext, rect: CGRect, for section: Int, isHovered: Bool, isExpanded: Bool, isSelected: Bool) {
        if accordion === projectsAccordion {
            drawProjectRow(context: context, index: section, rect: rect, isHovered: isHovered, isExpanded: isExpanded, isSelected: isSelected)
        } else {
            drawPortsSectionHeader(context: context, rect: rect, isHovered: isHovered, isExpanded: isExpanded)
        }
    }

    // MARK: Item Drawing

    func accordion(_ accordion: AccordionView, drawItem context: CGContext, rect: CGRect, at indexPath: IndexPath, isHovered: Bool, isSelected: Bool) {
        if accordion === projectsAccordion {
            let items = sortedWorktrees(forProject: indexPath.section)
            guard indexPath.item < items.count else { return }
            drawWorktreeRow(context: context, item: items[indexPath.item], projectIndex: indexPath.section,
                            rect: rect, isHovered: isHovered, isSelected: isSelected)
        } else {
            guard indexPath.item < activePorts.count else { return }
            drawPortRow(context: context, port: activePorts[indexPath.item], rect: rect, isHovered: isHovered)
        }
    }

    // MARK: Section Toggle

    func accordion(_ accordion: AccordionView, shouldToggleSection section: Int) -> Bool {
        accordion === portsAccordion
    }

    func accordion(_ accordion: AccordionView, didTapSection section: Int, localPoint: CGPoint, event: NSEvent) {
        guard accordion === projectsAccordion else { return }
        guard section < projects.count else { return }
        let project = projects[section]

        // "+" add-worktree button (right edge)
        if localPoint.x >= accordion.bounds.width - 22 {
            delegate?.sidebar(self, didRequestCreateWorktree: section)
            return
        }

        // Chevron area (left edge) — toggle expansion (chevron drawn at projectInsetX, width ~16)
        if localPoint.x < projectInsetX + 16, !project.worktrees.isEmpty {
            accordion.toggle(section: section)
            return
        }

        delegate?.sidebar(self, didSelectProject: section)
    }

    // MARK: Item Click

    func accordion(_ accordion: AccordionView, didClickItem indexPath: IndexPath, localPoint: CGPoint, in rect: CGRect, event: NSEvent) {
        if accordion === projectsAccordion {
            let items = sortedWorktrees(forProject: indexPath.section)
            guard indexPath.item < items.count else { return }
            let item = items[indexPath.item]

            if item.info.isCheckedOut || item.info.isMain {
                if item.hasRunCommand && localPoint.x >= accordion.bounds.width - 22 {
                    delegate?.sidebar(self, didRequestRunCommand: item.info, inProject: indexPath.section)
                } else {
                    delegate?.sidebar(self, didSelectWorktree: item.info, inProject: indexPath.section)
                }
            } else {
                delegate?.sidebar(self, didRequestCheckoutDefaultBranch: indexPath.section)
            }
        } else {
            guard indexPath.item < activePorts.count else { return }
            let port = activePorts[indexPath.item]
            if let labelRect = worktreeLabelRect(for: port, in: rect), labelRect.contains(localPoint) {
                delegate?.sidebar(self, didClickPortWorktreeFor: port)
            } else {
                delegate?.sidebar(self, didClickPort: port)
            }
        }
    }

    // MARK: Double-Click

    func accordion(_ accordion: AccordionView, didDoubleClickItem indexPath: IndexPath) {
        guard accordion === projectsAccordion else { return }
        let items = sortedWorktrees(forProject: indexPath.section)
        guard indexPath.item < items.count else { return }
        let item = items[indexPath.item]
        guard item.info.isCheckedOut else { return }

        let itemYInAccordion = projectsAccordion.yPosition(forItem: indexPath) ?? 0
        let rowY = projectsAccordion.frame.minY + itemYInAccordion
        beginRename(projectIndex: indexPath.section, item: item, rowY: rowY)
    }

    // MARK: Right-Click

    func accordion(_ accordion: AccordionView, didRightClickSection section: Int, with event: NSEvent) {
        guard accordion === projectsAccordion, section < projects.count else { return }
        let menu = NSMenu()

        let newWT = menu.addItem(withTitle: "New Worktree", action: #selector(menuCreateWorktree(_:)), keyEquivalent: "")
        newWT.representedObject = section
        newWT.target = self

        menu.addItem(NSMenuItem.separator())

        let settings = menu.addItem(withTitle: "Project Settings…", action: #selector(menuProjectSettings(_:)), keyEquivalent: "")
        settings.representedObject = section
        settings.target = self

        menu.addItem(NSMenuItem.separator())

        let remove = menu.addItem(withTitle: "Remove Project", action: #selector(menuRemoveProject(_:)), keyEquivalent: "")
        remove.representedObject = section
        remove.target = self

        NSMenu.popUpContextMenu(menu, with: event, for: accordion)
    }

    func accordion(_ accordion: AccordionView, didRightClickItem indexPath: IndexPath, with event: NSEvent) {
        guard accordion === projectsAccordion else { return }
        let items = sortedWorktrees(forProject: indexPath.section)
        guard indexPath.item < items.count else { return }
        let item = items[indexPath.item]
        guard item.info.isCheckedOut else { return }

        let menu = NSMenu()

        let rename = menu.addItem(withTitle: "Rename…", action: #selector(menuRenameWorktree(_:)), keyEquivalent: "")
        rename.representedObject = indexPath
        rename.target = self

        menu.addItem(NSMenuItem.separator())

        let delete = menu.addItem(withTitle: "Delete Worktree…", action: #selector(menuDeleteWorktree(_:)), keyEquivalent: "")
        delete.representedObject = indexPath
        delete.target = self
        delete.isEnabled = !item.info.isMain

        NSMenu.popUpContextMenu(menu, with: event, for: accordion)
    }

    // MARK: Layout

    func accordionDidChangeContentHeight(_ accordion: AccordionView) {
        layoutAccordions()
    }

    func accordion(_ accordion: AccordionView, maxVisibleItemsHeightForSection section: Int) -> CGFloat? {
        guard accordion === portsAccordion else { return nil }
        return portsMaxVisibleItemsHeight
    }
}

// MARK: - Context Menu Actions

extension ProjectSidebarView {
    @objc private func menuCreateWorktree(_ item: NSMenuItem) {
        guard let index = item.representedObject as? Int else { return }
        delegate?.sidebar(self, didRequestCreateWorktree: index)
    }

    @objc private func menuProjectSettings(_ item: NSMenuItem) {
        guard let index = item.representedObject as? Int else { return }
        delegate?.sidebar(self, didRequestProjectSettings: index)
    }

    @objc private func menuRemoveProject(_ item: NSMenuItem) {
        guard let index = item.representedObject as? Int else { return }
        delegate?.sidebar(self, didRequestRemoveProject: index)
    }

    @objc private func menuRenameWorktree(_ item: NSMenuItem) {
        guard let indexPath = item.representedObject as? IndexPath else { return }
        let items = sortedWorktrees(forProject: indexPath.section)
        guard indexPath.item < items.count else { return }
        let wtItem = items[indexPath.item]
        let itemYInAccordion = projectsAccordion.yPosition(forItem: indexPath) ?? 0
        let rowY = projectsAccordion.frame.minY + itemYInAccordion
        beginRename(projectIndex: indexPath.section, item: wtItem, rowY: rowY)
    }

    @objc private func menuDeleteWorktree(_ item: NSMenuItem) {
        guard let indexPath = item.representedObject as? IndexPath else { return }
        let items = sortedWorktrees(forProject: indexPath.section)
        guard indexPath.item < items.count else { return }
        delegate?.sidebar(self, didRequestDeleteWorktree: items[indexPath.item].info, inProject: indexPath.section)
    }
}

// MARK: - Drawing Helpers

private extension ProjectSidebarView {

    func drawProjectRow(context: CGContext, index: Int, rect: CGRect, isHovered: Bool, isExpanded: Bool, isSelected: Bool) {
        guard index < projects.count else { return }
        let project = projects[index]

        if isSelected {
            context.setFillColor(selectedColor.cgColor)
            context.fill(rect)
        } else if isHovered {
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        let hasWorktrees = !project.worktrees.isEmpty
        let chevronWidth: CGFloat = hasWorktrees ? 16 : 0

        if hasWorktrees {
            let symbolName = isExpanded ? "chevron.down" : "chevron.right"
            if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
                let cfg = NSImage.SymbolConfiguration(pointSize: 9, weight: .medium)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [isSelected ? selectedTextColor : dimTextColor]))
                let sized = img.withSymbolConfiguration(cfg) ?? img
                let iw = sized.size.width, ih = sized.size.height
                let imgRect = CGRect(x: projectInsetX, y: rect.minY + (rect.height - ih) / 2, width: iw, height: ih)
                sized.draw(in: imgRect, from: .zero, operation: .sourceOver, fraction: 1,
                           respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            }
        }

        let nameAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: isSelected ? selectedTextColor : textColor,
            .font: NSFont.systemFont(ofSize: 12, weight: isSelected ? .medium : .regular),
        ]
        let rightReserved: CGFloat = isHovered ? 24 : 8
        let nameX = projectInsetX + chevronWidth
        let nameRect = CGRect(x: nameX, y: rect.minY + 5, width: rect.width - nameX - rightReserved, height: 16)
        (project.name as NSString).draw(in: nameRect, withAttributes: nameAttrs)

        if isHovered {
            let addAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: dimTextColor,
                .font: NSFont.systemFont(ofSize: 13, weight: .light),
            ]
            ("+" as NSString).draw(at: CGPoint(x: rect.width - 18, y: rect.minY + 4), withAttributes: addAttrs)
        }
    }

    func drawWorktreeRow(context: CGContext, item: WorktreeViewItem, projectIndex: Int, rect: CGRect, isHovered: Bool, isSelected: Bool) {
        let isCheckedOut = item.info.isCheckedOut || item.info.isMain

        let line1Y = rect.minY + 5

        let iconColor = !isCheckedOut ? uncheckedColor : (isSelected ? selectedTextColor : dimTextColor)
        let iconAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: iconColor,
            .font: NSFont.systemFont(ofSize: 10),
        ]
        ("\u{2387}" as NSString).draw(at: CGPoint(x: worktreeInsetX - 12, y: line1Y), withAttributes: iconAttrs)

        // Diff stats (right side, line 1)
        var diffStatWidth: CGFloat = 0
        if let stat = item.diffStat {
            let addStr = "+\(stat.additions)" as NSString
            let delStr = "-\(stat.deletions)" as NSString
            let statFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
            let addAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: NSColor(red: 0.3, green: 0.8, blue: 0.4, alpha: 1), .font: statFont,
            ]
            let delAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: NSColor(red: 0.9, green: 0.35, blue: 0.35, alpha: 1), .font: statFont,
            ]
            let spaceAttrs: [NSAttributedString.Key: Any] = [.foregroundColor: dimTextColor, .font: statFont]
            let addSize = addStr.size(withAttributes: addAttrs)
            let delSize = delStr.size(withAttributes: delAttrs)
            let spaceSize = ("  " as NSString).size(withAttributes: spaceAttrs)
            diffStatWidth = addSize.width + spaceSize.width + delSize.width + 6
            let rightPad: CGFloat = 6
            let delX = rect.width - rightPad - delSize.width
            let addX = delX - spaceSize.width - addSize.width
            addStr.draw(at: CGPoint(x: addX, y: line1Y), withAttributes: addAttrs)
            delStr.draw(at: CGPoint(x: delX, y: line1Y), withAttributes: delAttrs)
        }

        // Branch name / label (line 1)
        let labelColor = !isCheckedOut ? uncheckedColor : (isSelected ? selectedTextColor : textColor)
        let labelFont: NSFont = !isCheckedOut
            ? NSFont.systemFont(ofSize: 11, weight: .light)
            : NSFont.systemFont(ofSize: 11, weight: isSelected ? .medium : .regular)
        let rightReservedForLabel: CGFloat = diffStatWidth > 0
            ? diffStatWidth + 4
            : (isHovered && (item.hasRunCommand || !isCheckedOut) ? 24 : 8)
        let branchAttrs: [NSAttributedString.Key: Any] = [.foregroundColor: labelColor, .font: labelFont]
        let textRect = CGRect(x: worktreeInsetX, y: line1Y, width: rect.width - worktreeInsetX - rightReservedForLabel, height: 14)

        let isRenaming = renameState?.projectIndex == projectIndex && renameState?.item.info.path == item.info.path
        if !isRenaming {
            (item.label as NSString).draw(in: textRect, withAttributes: branchAttrs)
        }

        // Hover button (run or checkout)
        if isHovered {
            if isCheckedOut && item.hasRunCommand {
                let runAttrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: dimTextColor, .font: NSFont.systemFont(ofSize: 10),
                ]
                ("\u{25B6}" as NSString).draw(at: CGPoint(x: rect.width - 18, y: rect.minY + 6), withAttributes: runAttrs)
            } else if !isCheckedOut {
                let coAttrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: dimTextColor, .font: NSFont.systemFont(ofSize: 9),
                ]
                ("co" as NSString).draw(at: CGPoint(x: rect.width - 20, y: rect.minY + 6), withAttributes: coAttrs)
            }
        }
    }

    func drawPortsSectionHeader(context: CGContext, rect: CGRect, isHovered: Bool, isExpanded: Bool) {
        if isHovered {
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        let symbolName = isExpanded ? "chevron.down" : "chevron.right"
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 10, weight: .regular)
                .applying(NSImage.SymbolConfiguration(paletteColors: [dimTextColor]))
            let sized = img.withSymbolConfiguration(cfg) ?? img
            let iw = sized.size.width, ih = sized.size.height
            let imgRect = CGRect(x: 5, y: rect.minY + (rect.height - ih) / 2, width: iw, height: ih)
            sized.draw(in: imgRect, from: .zero, operation: .sourceOver, fraction: 1,
                       respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
        }

        let headerAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dimTextColor,
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        ("PORTS" as NSString).draw(at: CGPoint(x: 20, y: rect.minY + 8), withAttributes: headerAttrs)
    }

    func drawPortRow(context: CGContext, port: ActivePort, rect: CGRect, isHovered: Bool) {
        let dotSize: CGFloat = 6
        let dotRect = CGRect(x: projectInsetX, y: rect.minY + (rect.height - dotSize) / 2, width: dotSize, height: dotSize)
        context.setFillColor(NSColor(srgbRed: 0.3, green: 0.8, blue: 0.4, alpha: 1).cgColor)
        context.fillEllipse(in: dotRect)

        if let worktreeRect = worktreeLabelRect(for: port, in: rect),
           let branch = port.worktreePath.flatMap({ branchName(for: $0) }) {
            let branchAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: dimTextColor, .font: NSFont.systemFont(ofSize: 9),
            ]
            (branch as NSString).draw(at: CGPoint(x: worktreeRect.minX + 1, y: worktreeRect.minY), withAttributes: branchAttrs)

            let portAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: isHovered ? selectedTextColor : textColor,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
            ]
            let label = ":\(port.port) \(port.processName)"
            let rightMargin: CGFloat = rect.width - worktreeRect.minX + 4
            let textRect = CGRect(
                x: projectInsetX + dotSize + 6, y: rect.minY + 4,
                width: rect.width - projectInsetX - dotSize - 6 - rightMargin, height: 14
            )
            (label as NSString).draw(in: textRect, withAttributes: portAttrs)
        } else {
            let portAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: isHovered ? selectedTextColor : textColor,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
            ]
            let label = ":\(port.port) \(port.processName)"
            let textRect = CGRect(
                x: projectInsetX + dotSize + 6, y: rect.minY + 4,
                width: rect.width - projectInsetX - dotSize - 20, height: 14
            )
            (label as NSString).draw(in: textRect, withAttributes: portAttrs)
        }
    }
}

// MARK: - NSTextFieldDelegate (Rename)

extension ProjectSidebarView: NSTextFieldDelegate {
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control.tag == 9999 else { return false }
        if commandSelector == #selector(insertNewline(_:)) { commitRename(); return true }
        if commandSelector == #selector(cancelOperation(_:)) { cancelRename(); return true }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard (obj.object as? NSTextField)?.tag == 9999 else { return }
        if renameState != nil { commitRename() }
    }
}

// MARK: - Array safe subscript

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
