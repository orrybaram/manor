import AppKit
import ManorCore

// MARK: - Divider View

/// A thin view placed between split panes that can be dragged to resize.
private final class PaneDividerView: NSView {
    var direction: SplitDirection = .horizontal
    var splitPath: [Int] = []
    var parentRect: NSRect = .zero
    var onDrag: (([Int], CGFloat) -> Void)?

    private var isDragging = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(srgbRed: 0.2, green: 0.2, blue: 0.2, alpha: 1).cgColor
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    override func resetCursorRects() {
        let cursor: NSCursor = direction == .horizontal ? .resizeLeftRight : .resizeUpDown
        addCursorRect(bounds, cursor: cursor)
    }

    override func mouseDown(with event: NSEvent) {
        isDragging = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard isDragging else { return }
        let locationInParent = superview?.convert(event.locationInWindow, from: nil) ?? .zero

        let newRatio: CGFloat
        switch direction {
        case .horizontal:
            let relative = locationInParent.x - parentRect.minX
            newRatio = max(0.1, min(0.9, relative / parentRect.width))
        case .vertical:
            let relative = locationInParent.y - parentRect.minY
            newRatio = max(0.1, min(0.9, relative / parentRect.height))
        }

        onDrag?(splitPath, newRatio)
    }

    override func mouseUp(with event: NSEvent) {
        isDragging = false
    }
}

// MARK: - Pane Container View

/// Renders a PaneNode tree as nested split views.
final class PaneContainerView: NSView {
    private var paneViews: [PaneID: GhosttySurfaceView] = [:]
    private var focusedPaneID: PaneID?
    private var dividers: [PaneDividerView] = []
    private var dividerIndex: Int = 0

    var onPaneCreated: ((PaneID, GhosttySurfaceView) -> Void)?
    var onPaneClosed: ((PaneID) -> Void)?
    var onFocusChanged: ((PaneID) -> Void)?
    var onRatioChanged: (([Int], CGFloat) -> Void)?

    private let dividerWidth: CGFloat = 6

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
    }

    // MARK: - Layout

    func layout(node: PaneNode, in rect: NSRect) {
        // Hide views not in the current tree (don't destroy — they may belong to other tabs)
        let activeIDs = Set(node.allPaneIDs)
        for (id, view) in paneViews where !activeIDs.contains(id) {
            view.removeFromSuperview()
        }

        // Reset divider pool index
        dividerIndex = 0
        layoutNode(node, in: rect, path: [])

        // Hide unused dividers
        for i in dividerIndex..<dividers.count {
            dividers[i].isHidden = true
        }
    }

    /// Permanently remove and destroy a pane view (used when closing a pane/tab).
    func destroyPaneView(for paneID: PaneID) {
        guard let view = paneViews.removeValue(forKey: paneID) else { return }
        view.removeFromSuperview()
    }

    private func layoutNode(_ node: PaneNode, in rect: NSRect, path: [Int]) {
        switch node {
        case .leaf(let paneID):
            let surfaceView: GhosttySurfaceView
            if let existing = paneViews[paneID] {
                surfaceView = existing
                if existing.superview != self {
                    addSubview(existing)
                }
            } else {
                surfaceView = GhosttySurfaceView(frame: rect)
                surfaceView.paneID = paneID
                addSubview(surfaceView)
                paneViews[paneID] = surfaceView
                onPaneCreated?(paneID, surfaceView)
            }

            surfaceView.frame = rect

        case .split(let direction, let ratio, let first, let second):
            let (firstRect, secondRect) = splitRect(rect, direction: direction, ratio: ratio)
            layoutNode(first, in: firstRect, path: path + [0])
            layoutNode(second, in: secondRect, path: path + [1])

            // Place divider between the two rects
            let divider = obtainDivider()
            divider.direction = direction
            divider.splitPath = path
            divider.parentRect = rect
            divider.onDrag = { [weak self] splitPath, newRatio in
                self?.onRatioChanged?(splitPath, newRatio)
            }

            let dividerFrame: NSRect
            switch direction {
            case .horizontal:
                dividerFrame = NSRect(
                    x: firstRect.maxX,
                    y: rect.minY,
                    width: dividerWidth,
                    height: rect.height
                )
            case .vertical:
                dividerFrame = NSRect(
                    x: rect.minX,
                    y: firstRect.maxY,
                    width: rect.width,
                    height: dividerWidth
                )
            }
            divider.frame = dividerFrame
            divider.isHidden = false
            divider.resetCursorRects()
        }
    }

    /// Get or create a divider view from the pool.
    private func obtainDivider() -> PaneDividerView {
        if dividerIndex < dividers.count {
            let d = dividers[dividerIndex]
            dividerIndex += 1
            return d
        }
        let d = PaneDividerView()
        addSubview(d)
        dividers.append(d)
        dividerIndex += 1
        return d
    }

    private func splitRect(_ rect: NSRect, direction: SplitDirection, ratio: CGFloat) -> (NSRect, NSRect) {
        let divider = dividerWidth
        switch direction {
        case .horizontal:
            let firstWidth = (rect.width - divider) * ratio
            let firstRect = NSRect(x: rect.minX, y: rect.minY, width: firstWidth, height: rect.height)
            let secondRect = NSRect(
                x: rect.minX + firstWidth + divider,
                y: rect.minY,
                width: rect.width - firstWidth - divider,
                height: rect.height
            )
            return (firstRect, secondRect)

        case .vertical:
            let firstHeight = (rect.height - divider) * ratio
            let firstRect = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: firstHeight)
            let secondRect = NSRect(
                x: rect.minX,
                y: rect.minY + firstHeight + divider,
                width: rect.width,
                height: rect.height - firstHeight - divider
            )
            return (firstRect, secondRect)
        }
    }

    // MARK: - Focus

    func setFocus(_ paneID: PaneID) {
        focusedPaneID = paneID
        if let view = paneViews[paneID] {
            window?.makeFirstResponder(view)
        }
        onFocusChanged?(paneID)
    }

    func surfaceView(for paneID: PaneID) -> GhosttySurfaceView? {
        return paneViews[paneID]
    }

    // MARK: - Hit Testing for Focus

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        for (paneID, view) in paneViews {
            if view.frame.contains(point) {
                setFocus(paneID)
                return
            }
        }
        super.mouseDown(with: event)
    }
}
