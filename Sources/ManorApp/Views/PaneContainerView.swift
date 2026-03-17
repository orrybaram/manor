import AppKit

/// Renders a PaneNode tree as nested split views.
final class PaneContainerView: NSView {
    private var paneViews: [PaneID: GhosttySurfaceView] = [:]
    private var focusedPaneID: PaneID?

    var onPaneCreated: ((PaneID, GhosttySurfaceView) -> Void)?
    var onPaneClosed: ((PaneID) -> Void)?
    var onFocusChanged: ((PaneID) -> Void)?

    // Border colors
    private let focusedBorderColor = NSColor(srgbRed: 0.3, green: 0.6, blue: 1.0, alpha: 1)
    private let unfocusedBorderColor = NSColor(srgbRed: 0.3, green: 0.3, blue: 0.3, alpha: 1)
    private let borderWidth: CGFloat = 1
    private let dividerWidth: CGFloat = 2

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
        // Remove views not in the tree
        let activeIDs = Set(node.allPaneIDs)
        for (id, view) in paneViews where !activeIDs.contains(id) {
            view.destroySurface()
            view.removeFromSuperview()
            paneViews.removeValue(forKey: id)
        }

        layoutNode(node, in: rect)
    }

    private func layoutNode(_ node: PaneNode, in rect: NSRect) {
        switch node {
        case .leaf(let paneID):
            let surfaceView: GhosttySurfaceView
            if let existing = paneViews[paneID] {
                surfaceView = existing
            } else {
                surfaceView = GhosttySurfaceView(frame: rect)
                surfaceView.paneID = paneID
                addSubview(surfaceView)
                paneViews[paneID] = surfaceView
                onPaneCreated?(paneID, surfaceView)
            }

            // Inset for border
            let insetRect = rect.insetBy(dx: borderWidth, dy: borderWidth)
            surfaceView.frame = insetRect

            // Border
            surfaceView.wantsLayer = true
            let isFocused = paneID == focusedPaneID
            surfaceView.layer?.borderColor = (isFocused ? focusedBorderColor : unfocusedBorderColor).cgColor
            surfaceView.layer?.borderWidth = isFocused ? 2 : 1

        case .split(let direction, let ratio, let first, let second):
            let (firstRect, secondRect) = splitRect(rect, direction: direction, ratio: ratio)
            layoutNode(first, in: firstRect)
            layoutNode(second, in: secondRect)
        }
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
        // Update borders
        for (id, view) in paneViews {
            let isFocused = id == paneID
            view.layer?.borderColor = (isFocused ? focusedBorderColor : unfocusedBorderColor).cgColor
            view.layer?.borderWidth = isFocused ? 2 : 1
        }
        onFocusChanged?(paneID)
    }

    func surfaceView(for paneID: PaneID) -> GhosttySurfaceView? {
        return paneViews[paneID]
    }

    // MARK: - Resize

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
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
