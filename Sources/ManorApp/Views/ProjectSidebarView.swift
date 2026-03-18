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
            for project in projects {
                expandedProjectIDs.insert(project.id)
            }
            needsDisplay = true
        }
    }
    var selectedProjectIndex: Int = 0 {
        didSet {
            // Auto-expand selected project to show worktree selection
            if selectedProjectIndex < projects.count {
                let project = projects[selectedProjectIndex]
                if project.worktrees.count > 1 {
                    expandedProjectIDs.insert(project.id)
                }
            }
            needsDisplay = true
        }
    }
    var expandedProjectIDs: Set<UUID> = [] {
        didSet { needsDisplay = true }
    }
    var activePorts: [ActivePort] = [] {
        didSet {
            let maxOffset = max(0, CGFloat(activePorts.count) * portRowHeight - bounds.height * 0.5)
            if portsScrollOffset > maxOffset {
                portsScrollOffset = maxOffset
            }
            needsDisplay = true
        }
    }
    var isPortsSectionExpanded: Bool = true {
        didSet { needsDisplay = true }
    }

    // Layout constants
    private let rowHeight: CGFloat = 26
    private let worktreeRowHeight: CGFloat = 22
    private let expandedWorktreeRowHeight: CGFloat = 42
    private let projectInsetX: CGFloat = 12
    private let worktreeInsetX: CGFloat = 28
    private let trafficLightPadding: CGFloat = 28
    private let headerHeight: CGFloat = 36
    private let addButtonHeight: CGFloat = 30

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

    // Ports section
    private let portRowHeight: CGFloat = 22
    private let portsSectionHeaderHeight: CGFloat = 28
    private let portsSectionPadding: CGFloat = 8
    private var portsScrollOffset: CGFloat = 0

    // Hover state
    private var hoverRowIndex: Int?
    private var hoverPortIndex: Int?
    private var hoverPortsHeader: Bool = false
    private var trackingArea: NSTrackingArea?

    // Rename overlay
    private struct RenameState {
        let projectIndex: Int
        let item: WorktreeViewItem
        let textField: NSTextField
    }
    private var renameState: RenameState?

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

    override init(frame: NSRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        wantsLayer = true
        layer?.backgroundColor = backgroundColor.cgColor
    }

    // MARK: - Row Model

    private enum Row {
        case project(index: Int)
        case worktree(projectIndex: Int, item: WorktreeViewItem)
    }

    private func buildRows() -> [Row] {
        var rows: [Row] = []
        for (i, project) in projects.enumerated() {
            rows.append(.project(index: i))
            if expandedProjectIDs.contains(project.id) {
                let sorted = project.worktrees.sorted { $0.info.isMain && !$1.info.isMain }
                for item in sorted {
                    rows.append(.worktree(projectIndex: i, item: item))
                }
            }
        }
        return rows
    }

    // MARK: - Variable Row Height Helpers

    private func height(for row: Row) -> CGFloat {
        switch row {
        case .project:
            return rowHeight
        case .worktree(_, let item):
            return (item.prInfo != nil || item.diffStat != nil) ? expandedWorktreeRowHeight : rowHeight
        }
    }

    private func rowYPositions(for rows: [Row]) -> [CGFloat] {
        var positions: [CGFloat] = []
        var y = rowsTop()
        for row in rows {
            positions.append(y)
            y += height(for: row)
        }
        return positions
    }

    private func totalRowsHeight(for rows: [Row]) -> CGFloat {
        rows.reduce(0) { $0 + height(for: $1) }
    }

    private func rowIndex(for point: CGPoint, in rows: [Row]) -> Int? {
        let positions = rowYPositions(for: rows)
        for (i, (row, yPos)) in zip(rows, positions).enumerated() {
            let h = height(for: row)
            if point.y >= yPos && point.y < yPos + h {
                return i
            }
        }
        return nil
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        context.setFillColor(backgroundColor.cgColor)
        context.fill(bounds)

        let contentTop = trafficLightPadding
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dimTextColor,
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        ("PROJECTS" as NSString).draw(
            at: CGPoint(x: projectInsetX, y: contentTop + 14),
            withAttributes: headerAttrs
        )
        let addHeaderStr = "Add +" as NSString
        let addHeaderSize = addHeaderStr.size(withAttributes: headerAttrs)
        addHeaderStr.draw(
            at: CGPoint(x: bounds.width - addHeaderSize.width - projectInsetX, y: contentTop + 14),
            withAttributes: headerAttrs
        )

        let rows = buildRows()
        let rowsTopY = contentTop + headerHeight
        let positions = rowYPositions(for: rows)
        for (i, row) in rows.enumerated() {
            let y = positions[i]

            switch row {
            case .project(let index):
                drawProjectRow(context: context, index: index, y: y, rowH: height(for: row), isHovered: hoverRowIndex == i)
            case .worktree(let projectIndex, let item):
                drawWorktreeRow(context: context, item: item, projectIndex: projectIndex, y: y, rowH: height(for: row), isHovered: hoverRowIndex == i)
            }
        }

        if !activePorts.isEmpty {
            let projectsBottomY = rowsTopY + totalRowsHeight(for: rows) + 8
            let dividerY = max(projectsBottomY, portsSectionTop - portsSectionPadding)
            context.setFillColor(dividerColor.cgColor)
            context.fill(CGRect(x: 0, y: dividerY, width: bounds.width - 1, height: 1))
            drawPortsSection(context: context, y: portsSectionTop, clipTop: dividerY + 1 + portsSectionPadding)
        }

        // Right-edge divider
        context.setFillColor(dividerColor.cgColor)
        context.fill(CGRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height))
    }

    private func drawProjectRow(context: CGContext, index: Int, y: CGFloat, rowH: CGFloat, isHovered: Bool) {
        let rect = CGRect(x: 0, y: y, width: bounds.width, height: rowH)
        let project = projects[index]
        let isSelected = index == selectedProjectIndex
        let isExpanded = expandedProjectIDs.contains(project.id)

        if isSelected {
            context.setFillColor(selectedColor.cgColor)
            context.fill(rect)
        } else if isHovered {
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        // Disclosure triangle
        let hasWorktrees = project.worktrees.count > 1
        let chevronWidth: CGFloat = hasWorktrees ? 16 : 0
        if hasWorktrees {
            let symbolName = isExpanded ? "chevron.down" : "chevron.right"
            if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
                let cfg = NSImage.SymbolConfiguration(pointSize: 9, weight: .medium)
                let sized = img.withSymbolConfiguration(cfg) ?? img
                let iw = sized.size.width, ih = sized.size.height
                let imgRect = CGRect(x: projectInsetX, y: y + (rowH - ih) / 2, width: iw, height: ih)
                (isSelected ? selectedTextColor : textColor).set()
                sized.draw(in: imgRect, from: .zero, operation: .sourceOver, fraction: 1,
                           respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            }
        }

        // Project name
        let nameAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: isSelected ? selectedTextColor : textColor,
            .font: NSFont.systemFont(ofSize: 12, weight: isSelected ? .medium : .regular),
        ]
        let rightReserved: CGFloat = isHovered ? 24 : 8
        let nameX = projectInsetX + chevronWidth
        let nameRect = CGRect(x: nameX, y: y + 5, width: bounds.width - nameX - rightReserved, height: 16)
        (project.name as NSString).draw(in: nameRect, withAttributes: nameAttrs)

        // Hover button: [+] add worktree
        if isHovered {
            let addAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: dimTextColor,
                .font: NSFont.systemFont(ofSize: 13, weight: .light),
            ]
            ("+" as NSString).draw(
                at: CGPoint(x: bounds.width - 18, y: y + 4),
                withAttributes: addAttrs
            )
        }
    }

    private func drawWorktreeRow(context: CGContext, item: WorktreeViewItem, projectIndex: Int, y: CGFloat, rowH: CGFloat, isHovered: Bool) {
        let isSelected = projectIndex == selectedProjectIndex &&
            projects[projectIndex].selectedWorktreePath == item.info.path
        let isCheckedOut = item.info.isCheckedOut
        let hasExtraInfo = item.prInfo != nil || item.diffStat != nil

        if isSelected {
            let rect = CGRect(x: 0, y: y, width: bounds.width, height: rowH)
            context.setFillColor(selectedColor.cgColor)
            context.fill(rect)
        } else if isHovered {
            let rect = CGRect(x: 0, y: y, width: bounds.width, height: rowH)
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        let line1Y = hasExtraInfo ? y + 8 : y + 5

        // Branch icon
        let iconColor = !isCheckedOut ? uncheckedColor
            : (isSelected ? selectedTextColor : dimTextColor)
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
                .foregroundColor: NSColor(red: 0.3, green: 0.8, blue: 0.4, alpha: 1),
                .font: statFont,
            ]
            let delAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: NSColor(red: 0.9, green: 0.35, blue: 0.35, alpha: 1),
                .font: statFont,
            ]
            let spaceAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: dimTextColor,
                .font: statFont,
            ]
            let addSize = addStr.size(withAttributes: addAttrs)
            let delSize = delStr.size(withAttributes: delAttrs)
            let spaceSize = ("  " as NSString).size(withAttributes: spaceAttrs)
            diffStatWidth = addSize.width + spaceSize.width + delSize.width + 6
            let rightPad: CGFloat = 6
            let delX = bounds.width - rightPad - delSize.width
            let addX = delX - spaceSize.width - addSize.width
            addStr.draw(at: CGPoint(x: addX, y: line1Y), withAttributes: addAttrs)
            delStr.draw(at: CGPoint(x: delX, y: line1Y), withAttributes: delAttrs)
        }

        // Branch name / display label (line 1)
        let labelColor = !isCheckedOut ? uncheckedColor
            : (isSelected ? selectedTextColor : textColor)
        let labelFont: NSFont = !isCheckedOut
            ? NSFont.systemFont(ofSize: 11, weight: .light)
            : NSFont.systemFont(ofSize: 11, weight: isSelected ? .medium : .regular)
        let rightReservedForLabel: CGFloat = diffStatWidth > 0 ? diffStatWidth + 4 : (isHovered && (item.hasRunCommand || !isCheckedOut) ? 24 : 8)
        let branchAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: labelColor,
            .font: labelFont,
        ]
        let textRect = CGRect(x: worktreeInsetX, y: line1Y, width: bounds.width - worktreeInsetX - rightReservedForLabel, height: 14)

        // Skip drawing label if we're actively renaming this row
        let isRenaming = renameState?.projectIndex == projectIndex && renameState?.item.info.path == item.info.path
        if !isRenaming {
            (item.label as NSString).draw(in: textRect, withAttributes: branchAttrs)
        }

        // PR badge (line 2, right-aligned)
        if let pr = item.prInfo {
            let line2Y = y + 24
            let prColor = pr.state.color
            let prFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)

            // SF Symbol for PR state
            let symbolName: String
            switch pr.state {
            case .open:   symbolName = "arrow.triangle.pull"
            case .merged: symbolName = "arrow.triangle.pull"
            case .closed: symbolName = "xmark.circle"
            }

            let prNumberStr = "#\(pr.number)" as NSString
            let prAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: dimTextColor,
                .font: prFont,
            ]
            let prSize = prNumberStr.size(withAttributes: prAttrs)
            let rightPad: CGFloat = 6
            let prX = bounds.width - rightPad - prSize.width
            prNumberStr.draw(at: CGPoint(x: prX, y: line2Y), withAttributes: prAttrs)

            // Draw SF symbol icon before the PR number
            if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
                let cfg = NSImage.SymbolConfiguration(pointSize: 9, weight: .regular)
                let sized = img.withSymbolConfiguration(cfg) ?? img
                let iw = sized.size.width, ih = sized.size.height
                let iconX = prX - iw - 3
                let iconY = line2Y + (prSize.height - ih) / 2
                let imgRect = CGRect(x: iconX, y: iconY, width: iw, height: ih)
                prColor.set()
                sized.draw(in: imgRect, from: .zero, operation: .sourceOver, fraction: 1,
                           respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            }
        }

        // Right-side hover button (only on 26px rows without extra info)
        if isHovered && !hasExtraInfo {
            if isCheckedOut && item.hasRunCommand {
                let runAttrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: dimTextColor,
                    .font: NSFont.systemFont(ofSize: 10),
                ]
                ("\u{25B6}" as NSString).draw(at: CGPoint(x: bounds.width - 18, y: y + 6), withAttributes: runAttrs)
            } else if !isCheckedOut {
                let coAttrs: [NSAttributedString.Key: Any] = [
                    .foregroundColor: dimTextColor,
                    .font: NSFont.systemFont(ofSize: 9),
                ]
                ("co" as NSString).draw(at: CGPoint(x: bounds.width - 20, y: y + 6), withAttributes: coAttrs)
            }
        }
    }

    // MARK: - Ports Section Drawing

    private var portsSectionTop: CGFloat {
        let visiblePortsHeight = isPortsSectionExpanded ? portsVisibleHeight : 0
        let portsHeight = portsSectionHeaderHeight + visiblePortsHeight
        let fromBottom = bounds.height - portsHeight - portsSectionPadding

        // Never overlap the projects content
        let rows = buildRows()
        let projectsBottomY = rowsTop() + totalRowsHeight(for: rows) + 8

        return max(fromBottom, projectsBottomY)
    }

    private var portsContentHeight: CGFloat {
        CGFloat(activePorts.count) * portRowHeight
    }

    private var portsVisibleHeight: CGFloat {
        // Available space between projects and bottom of sidebar
        let rows = buildRows()
        let projectsBottomY = rowsTop() + totalRowsHeight(for: rows) + 8
        let available = max(0, bounds.height - portsSectionPadding - portsSectionHeaderHeight - projectsBottomY)
        return min(portsContentHeight, min(bounds.height * 0.5, available))
    }

    private var maxPortsScrollOffset: CGFloat {
        max(0, portsContentHeight - portsVisibleHeight)
    }

    private func drawPortsSection(context: CGContext, y: CGFloat, clipTop: CGFloat) {
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dimTextColor,
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]

        let symbolName = isPortsSectionExpanded ? "chevron.down" : "chevron.right"
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 10, weight: .regular)
                .applying(NSImage.SymbolConfiguration(paletteColors: [dimTextColor]))
            let sized = img.withSymbolConfiguration(cfg) ?? img
            let iw = sized.size.width, ih = sized.size.height
            let imgRect = CGRect(x: 5, y: y + (portsSectionHeaderHeight - ih) / 2, width: iw, height: ih)
            sized.draw(in: imgRect, from: .zero, operation: .sourceOver, fraction: 1,
                       respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
        }

        if hoverPortsHeader {
            let headerRect = CGRect(x: 0, y: y, width: bounds.width, height: portsSectionHeaderHeight)
            context.setFillColor(hoverColor.cgColor)
            context.fill(headerRect)
        }

        ("PORTS" as NSString).draw(
            at: CGPoint(x: projectInsetX, y: y + 8),
            withAttributes: headerAttrs
        )

        guard isPortsSectionExpanded else { return }

        let portsAreaTop = y + portsSectionHeaderHeight
        let portsAreaBottom = portsAreaTop + portsVisibleHeight
        let clipRect = CGRect(x: 0, y: portsAreaTop, width: bounds.width, height: portsAreaBottom - portsAreaTop)

        context.saveGState()
        context.clip(to: clipRect)

        for (i, port) in activePorts.enumerated() {
            let rowY = portsAreaTop + CGFloat(i) * portRowHeight - portsScrollOffset
            if rowY + portRowHeight < portsAreaTop || rowY > portsAreaBottom { continue }
            drawPortRow(context: context, port: port, y: rowY, isHovered: hoverPortIndex == i)
        }

        context.restoreGState()
    }

    private func branchName(for worktreePath: String) -> String? {
        for project in projects {
            if let item = project.worktrees.first(where: { $0.info.path == worktreePath }) {
                return item.label
            }
        }
        return nil
    }

    private func worktreeLabelRect(for port: ActivePort, rowY: CGFloat) -> CGRect? {
        guard let path = port.worktreePath,
              let branch = branchName(for: path) else { return nil }
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 9)]
        let size = (branch as NSString).size(withAttributes: attrs)
        let labelX = bounds.width - size.width - 10
        return CGRect(x: labelX, y: rowY + 5, width: size.width + 2, height: 12)
    }

    private func drawPortRow(context: CGContext, port: ActivePort, y: CGFloat, isHovered: Bool) {
        if isHovered {
            let rect = CGRect(x: 0, y: y, width: bounds.width, height: portRowHeight)
            context.setFillColor(hoverColor.cgColor)
            context.fill(rect)
        }

        let dotSize: CGFloat = 6
        let dotRect = CGRect(x: projectInsetX, y: y + (portRowHeight - dotSize) / 2, width: dotSize, height: dotSize)
        context.setFillColor(NSColor(srgbRed: 0.3, green: 0.8, blue: 0.4, alpha: 1).cgColor)
        context.fillEllipse(in: dotRect)

        let worktreeRect = worktreeLabelRect(for: port, rowY: y)
        if let rect = worktreeRect, let branch = port.worktreePath.flatMap({ branchName(for: $0) }) {
            let branchAttrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: dimTextColor,
                .font: NSFont.systemFont(ofSize: 9),
            ]
            (branch as NSString).draw(at: CGPoint(x: rect.minX + 1, y: rect.minY), withAttributes: branchAttrs)
        }

        let portAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: isHovered ? selectedTextColor : textColor,
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
        ]
        let label = ":\(port.port) \(port.processName)"
        let rightMargin: CGFloat = worktreeRect != nil ? bounds.width - (worktreeRect!.minX) + 4 : 14
        let textRect = CGRect(
            x: projectInsetX + dotSize + 6,
            y: y + 4,
            width: bounds.width - projectInsetX - dotSize - 6 - rightMargin,
            height: 14
        )
        (label as NSString).draw(in: textRect, withAttributes: portAttrs)
    }

    // MARK: - Hit Testing Helpers

    private func rowsTop() -> CGFloat {
        trafficLightPadding + headerHeight
    }

    // rowIndex(for:) — kept for API compatibility but not used for hit testing (use rowIndex(for:in:))
    private func rowIndex(for point: CGPoint) -> Int? {
        let rows = buildRows()
        return rowIndex(for: point, in: rows)
    }

    // Hit rect for the [+] add-worktree button inside a project row
    private func addWorktreeButtonRect(forRow y: CGFloat) -> CGRect {
        CGRect(x: bounds.width - 22, y: y + 2, width: 18, height: rowHeight - 4)
    }

    // Hit rect for the [×] remove-project button
    private func removeProjectButtonRect(forRow y: CGFloat) -> CGRect {
        CGRect(x: bounds.width - 22, y: y + 2, width: 20, height: rowHeight - 4)
    }

    // Hit rect for the ▶ run-command button in a worktree row
    private func runCommandButtonRect(forRow y: CGFloat) -> CGRect {
        CGRect(x: bounds.width - 22, y: y + 3, width: 18, height: rowHeight - 6)
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)

        // Finish rename on click outside
        if renameState != nil {
            commitRename()
        }

        // Resize handle
        if point.x >= bounds.width - resizeHandleWidth {
            isResizing = true
            resizeStartX = point.x
            resizeStartWidth = bounds.width
            return
        }

        // Ports section
        if !activePorts.isEmpty {
            let psTop = portsSectionTop
            if point.y >= psTop {
                if point.y < psTop + portsSectionHeaderHeight {
                    isPortsSectionExpanded.toggle()
                    return
                }
                if isPortsSectionExpanded {
                    let portRowY = psTop + portsSectionHeaderHeight
                    let portIndex = Int((point.y - portRowY + portsScrollOffset) / portRowHeight)
                    if portIndex >= 0, portIndex < activePorts.count {
                        let port = activePorts[portIndex]
                        let rowY = portRowY + CGFloat(portIndex) * portRowHeight - portsScrollOffset
                        if let labelRect = worktreeLabelRect(for: port, rowY: rowY), labelRect.contains(point) {
                            delegate?.sidebar(self, didClickPortWorktreeFor: port)
                        } else {
                            delegate?.sidebar(self, didClickPort: port)
                        }
                        return
                    }
                }
            }
        }

        // Header "Add +" button
        let contentTop = trafficLightPadding
        if point.y >= contentTop && point.y <= contentTop + headerHeight {
            let headerAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            ]
            let addSize = ("Add +" as NSString).size(withAttributes: headerAttrs)
            let addX = bounds.width - addSize.width - projectInsetX - 4
            if point.x >= addX {
                delegate?.sidebarDidRequestAddProject(self)
                return
            }
        }

        let rows = buildRows()
        let top = rowsTop()
        let positions = rowYPositions(for: rows)

        guard point.y >= top else { return }
        guard let idx = rowIndex(for: point, in: rows) else { return }
        let y = positions[idx]

        switch rows[idx] {
        case .project(let index):
            let project = projects[index]
            // Add worktree button [+]
            if addWorktreeButtonRect(forRow: y).contains(point) {
                delegate?.sidebar(self, didRequestCreateWorktree: index)
                return
            }

            // Disclosure triangle
            if point.x < projectInsetX && !project.worktrees.isEmpty {
                toggleExpanded(project.id)
                return
            }

            delegate?.sidebar(self, didSelectProject: index)

        case .worktree(let projectIndex, let item):
            // Run command button ▶
            if item.hasRunCommand && item.info.isCheckedOut && runCommandButtonRect(forRow: y).contains(point) {
                delegate?.sidebar(self, didRequestRunCommand: item.info, inProject: projectIndex)
                return
            }

            // Checkout unchecked default branch
            if !item.info.isCheckedOut {
                delegate?.sidebar(self, didRequestCheckoutDefaultBranch: projectIndex)
                return
            }

            // Double-click = rename
            if event.clickCount == 2 {
                beginRename(projectIndex: projectIndex, item: item, rowY: y)
                return
            }

            delegate?.sidebar(self, didSelectWorktree: item.info, inProject: projectIndex)
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)

        let rows = buildRows()
        let top = rowsTop()
        guard point.y >= top else { return }
        guard let idx = rowIndex(for: point, in: rows) else { return }

        switch rows[idx] {
        case .project(let index):
            let menu = NSMenu()
            menu.addItem(withTitle: "New Worktree", action: nil, keyEquivalent: "")
            menu.items[0].target = self
            menu.items[0].representedObject = index
            menu.items[0].action = #selector(menuCreateWorktree(_:))

            menu.addItem(NSMenuItem.separator())

            let settings = menu.addItem(withTitle: "Project Settings…", action: #selector(menuProjectSettings(_:)), keyEquivalent: "")
            settings.representedObject = index
            settings.target = self

            menu.addItem(NSMenuItem.separator())

            let remove = menu.addItem(withTitle: "Remove Project", action: #selector(menuRemoveProject(_:)), keyEquivalent: "")
            remove.representedObject = index
            remove.target = self

            NSMenu.popUpContextMenu(menu, with: event, for: self)

        case .worktree(let projectIndex, let item):
            guard item.info.isCheckedOut else { return }
            let menu = NSMenu()

            let rename = menu.addItem(withTitle: "Rename…", action: #selector(menuRenameWorktree(_:)), keyEquivalent: "")
            rename.representedObject = (projectIndex, item, idx)
            rename.target = self

            menu.addItem(NSMenuItem.separator())

            let delete = menu.addItem(withTitle: "Delete Worktree…", action: #selector(menuDeleteWorktree(_:)), keyEquivalent: "")
            delete.representedObject = (projectIndex, item)
            delete.target = self
            // Cannot delete main worktree
            if item.info.isMain {
                delete.isEnabled = false
            }

            NSMenu.popUpContextMenu(menu, with: event, for: self)
        }
    }

    // MARK: - Context Menu Actions

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
        guard let tuple = item.representedObject as? (Int, WorktreeViewItem, Int) else { return }
        let (projectIndex, wtItem, rowIdx) = tuple
        let rows = buildRows()
        let positions = rowYPositions(for: rows)
        let rowY = rowIdx < positions.count ? positions[rowIdx] : rowsTop() + CGFloat(rowIdx) * rowHeight
        beginRename(projectIndex: projectIndex, item: wtItem, rowY: rowY)
    }

    @objc private func menuDeleteWorktree(_ item: NSMenuItem) {
        guard let tuple = item.representedObject as? (Int, WorktreeViewItem) else { return }
        let (projectIndex, wtItem) = tuple
        delegate?.sidebar(self, didRequestDeleteWorktree: wtItem.info, inProject: projectIndex)
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

    // MARK: - Drag (Resize)

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

    private func toggleExpanded(_ id: UUID) {
        if expandedProjectIDs.contains(id) {
            expandedProjectIDs.remove(id)
        } else {
            expandedProjectIDs.insert(id)
        }
    }

    // MARK: - Tracking (Hover)

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

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)

        if point.x >= bounds.width - resizeHandleWidth {
            NSCursor.resizeLeftRight.set()
        } else {
            NSCursor.arrow.set()
        }

        var newHoverRow: Int? = nil
        var newHoverPort: Int? = nil
        var newHoverPortsHeader = false

        if !activePorts.isEmpty {
            let psTop = portsSectionTop
            if point.y >= psTop {
                if point.y < psTop + portsSectionHeaderHeight {
                    newHoverPortsHeader = true
                } else if isPortsSectionExpanded {
                    let portRowY = psTop + portsSectionHeaderHeight
                    let portIndex = Int((point.y - portRowY + portsScrollOffset) / portRowHeight)
                    if portIndex >= 0, portIndex < activePorts.count {
                        newHoverPort = portIndex
                    }
                }

                if newHoverPort != hoverPortIndex || newHoverPortsHeader != hoverPortsHeader || hoverRowIndex != nil {
                    hoverPortIndex = newHoverPort
                    hoverPortsHeader = newHoverPortsHeader
                    hoverRowIndex = nil
                    needsDisplay = true
                }
                return
            }
        }

        let top = rowsTop()
        if point.y >= top {
            let rows = buildRows()
            newHoverRow = rowIndex(for: point, in: rows)
        }

        let portChanged = hoverPortIndex != nil || hoverPortsHeader
        if newHoverRow != hoverRowIndex || portChanged {
            hoverRowIndex = newHoverRow
            hoverPortIndex = nil
            hoverPortsHeader = false
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        NSCursor.arrow.set()
        let changed = hoverRowIndex != nil || hoverPortIndex != nil || hoverPortsHeader
        hoverRowIndex = nil
        hoverPortIndex = nil
        hoverPortsHeader = false
        if changed {
            needsDisplay = true
        }
    }

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)

        if !activePorts.isEmpty && isPortsSectionExpanded {
            let psTop = portsSectionTop + portsSectionHeaderHeight
            let psBottom = psTop + portsVisibleHeight
            if point.y >= psTop && point.y <= psBottom {
                let delta = event.scrollingDeltaY * (event.hasPreciseScrollingDeltas ? 1 : portRowHeight)
                portsScrollOffset = max(0, min(maxPortsScrollOffset, portsScrollOffset - delta))
                needsDisplay = true
                return
            }
        }

        super.scrollWheel(with: event)
    }

    override func resetCursorRects() {
        let clickableWidth = bounds.width - resizeHandleWidth

        addCursorRect(
            CGRect(x: clickableWidth, y: 0, width: resizeHandleWidth, height: bounds.height),
            cursor: .resizeLeftRight
        )

        let rows = buildRows()
        let positions = rowYPositions(for: rows)
        for (i, row) in rows.enumerated() {
            let y = positions[i]
            let h = height(for: row)
            addCursorRect(CGRect(x: 0, y: y, width: clickableWidth, height: h), cursor: .pointingHand)
        }

        let contentTop = trafficLightPadding
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        let addSize = ("Add +" as NSString).size(withAttributes: headerAttrs)
        let addX = bounds.width - addSize.width - projectInsetX - 4
        addCursorRect(CGRect(x: addX, y: contentTop, width: bounds.width - addX, height: headerHeight), cursor: .pointingHand)

        if !activePorts.isEmpty {
            let psTop = portsSectionTop
            addCursorRect(CGRect(x: 0, y: psTop, width: clickableWidth, height: portsSectionHeaderHeight), cursor: .pointingHand)
            if isPortsSectionExpanded {
                let portsAreaTop = psTop + portsSectionHeaderHeight
                for i in 0..<activePorts.count {
                    let y = portsAreaTop + CGFloat(i) * portRowHeight - portsScrollOffset
                    guard y + portRowHeight > portsAreaTop, y < portsAreaTop + portsVisibleHeight else { continue }
                    addCursorRect(CGRect(x: 0, y: y, width: clickableWidth, height: portRowHeight), cursor: .pointingHand)
                }
            }
        }
    }
}

// MARK: - NSTextFieldDelegate (Rename)

extension ProjectSidebarView: NSTextFieldDelegate {
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control.tag == 9999 else { return false }
        if commandSelector == #selector(insertNewline(_:)) {
            commitRename()
            return true
        }
        if commandSelector == #selector(cancelOperation(_:)) {
            cancelRename()
            return true
        }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard (obj.object as? NSTextField)?.tag == 9999 else { return }
        // Only commit if not already handled (avoid double-commit)
        if renameState != nil {
            commitRename()
        }
    }
}
