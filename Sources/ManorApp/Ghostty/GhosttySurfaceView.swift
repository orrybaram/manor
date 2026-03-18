import AppKit
import ManorCore
#if canImport(CGhosttyKit)
import CGhosttyKit
#endif
import QuartzCore

/// NSView that hosts a ghostty terminal surface.
/// GhosttyKit handles all rendering via Metal into this view's CAMetalLayer.
final class GhosttySurfaceView: NSView {
    private(set) var surface: ghostty_surface_t?

    /// Called when the surface's process exits or is closed.
    var onClose: (() -> Void)?

    /// Pane ID associated with this surface view (set externally).
    var paneID: PaneID?

    // MARK: - Init

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
        layerContentsRedrawPolicy = .duringViewResize
    }

    deinit {
        if let surface {
            ghostty_surface_free(surface)
        }
    }

    // MARK: - Tracking Area

    override func updateTrackingAreas() {
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: frame,
            options: [
                .mouseEnteredAndExited,
                .mouseMoved,
                .inVisibleRect,
                .activeAlways,
            ],
            owner: self,
            userInfo: nil
        ))
        super.updateTrackingAreas()
    }

    // MARK: - Layer Setup

    override func makeBackingLayer() -> CALayer {
        let metalLayer = CAMetalLayer()
        metalLayer.contentsScale = window?.backingScaleFactor ?? 2.0
        metalLayer.isOpaque = true
        return metalLayer
    }

    override var isFlipped: Bool { true }

    // MARK: - Surface Lifecycle

    /// Create the ghostty surface and attach it to this view.
    func createSurface(
        app: ghostty_app_t,
        config: ghostty_surface_config_s? = nil
    ) {
        guard surface == nil else { return }

        var sc = config ?? GhosttyApp.shared.newSurfaceConfig()
        sc.platform_tag = GHOSTTY_PLATFORM_MACOS
        sc.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(
                nsview: Unmanaged.passUnretained(self).toOpaque()
            )
        )
        sc.userdata = Unmanaged.passUnretained(self).toOpaque()

        let scaleFactor = window?.backingScaleFactor ?? 2.0
        sc.scale_factor = Double(scaleFactor)

        self.surface = ghostty_surface_new(app, &sc)

        if let surface {
            // Set initial size
            let size = boundsInPixels
            ghostty_surface_set_content_scale(surface, Double(scaleFactor), Double(scaleFactor))
            ghostty_surface_set_size(surface, UInt32(size.width), UInt32(size.height))

            // Set display ID if available
            if let screenNumber = window?.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 {
                ghostty_surface_set_display_id(surface, screenNumber)
            }
        }
    }

    func destroySurface() {
        if let surface {
            ghostty_surface_free(surface)
            self.surface = nil
        }
    }

    // MARK: - View Lifecycle

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let surface, let window else { return }

        let scale = window.backingScaleFactor
        if let metalLayer = layer as? CAMetalLayer {
            metalLayer.contentsScale = scale
        }
        ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))

        if let screenNumber = window.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 {
            ghostty_surface_set_display_id(surface, screenNumber)
        }
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        guard let window else { return }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let metalLayer = layer as? CAMetalLayer {
            metalLayer.contentsScale = window.backingScaleFactor
        }
        CATransaction.commit()

        guard let surface else { return }
        let scale = window.backingScaleFactor
        ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))

        let size = boundsInPixels
        ghostty_surface_set_size(surface, UInt32(size.width), UInt32(size.height))
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        guard let surface else { return }

        let scale = window?.backingScaleFactor ?? 2.0
        let wpx = UInt32(newSize.width * scale)
        let hpx = UInt32(newSize.height * scale)

        if let metalLayer = layer as? CAMetalLayer {
            metalLayer.drawableSize = CGSize(width: CGFloat(wpx), height: CGFloat(hpx))
        }

        ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
        ghostty_surface_set_size(surface, wpx, hpx)
    }

    // MARK: - Focus

    override var acceptsFirstResponder: Bool { true }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result, let surface {
            ghostty_surface_set_focus(surface, true)
        }
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result, let surface {
            ghostty_surface_set_focus(surface, false)
        }
        return result
    }

    // MARK: - Keyboard Input

    /// Accumulates text from `insertText` calls during `interpretKeyEvents`.
    /// Non-nil means we're inside a `keyDown` processing cycle.
    private var keyTextAccumulator: [String]?

    /// Marked text for IME composition (e.g. Korean, Japanese, Chinese input).
    private var markedText = NSMutableAttributedString()

    /// The original keyDown event currently being processed.
    private var currentKeyEvent: NSEvent?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, surface != nil else { return false }

        let flags = event.modifierFlags
        // Intercept control-key, command-key, and function-key (arrow keys,
        // F-keys, Home/End, etc.) events so AppKit doesn't swallow them
        // (e.g. Ctrl-C, Ctrl-R, arrow keys). Forward them to keyDown.
        if flags.contains(.control) || flags.contains(.command) || flags.contains(.function) {
            self.keyDown(with: event)
            return true
        }

        return false
    }

    override func keyDown(with event: NSEvent) {
        guard surface != nil else {
            self.interpretKeyEvents([event])
            return
        }

        let action: ghostty_input_action_e = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS

        // Track whether we had marked text before this event
        let markedTextBefore = markedText.length > 0

        // Begin accumulating text from interpretKeyEvents → insertText
        keyTextAccumulator = []
        currentKeyEvent = event
        defer {
            keyTextAccumulator = nil
            currentKeyEvent = nil
        }

        self.interpretKeyEvents([event])

        // Sync preedit state (IME composition)
        syncPreedit(clearIfNeeded: markedTextBefore)

        if let list = keyTextAccumulator, !list.isEmpty {
            // We got composed text from the input system — send each piece
            for text in list {
                sendKeyEvent(
                    action: action,
                    event: event,
                    text: text,
                    composing: false
                )
            }
        } else {
            // No composed text — send the raw key event.
            // composing is true if we have active preedit or just cleared it
            let noText: String? = nil
            sendKeyEvent(
                action: action,
                event: event,
                text: noText,
                composing: markedText.length > 0 || markedTextBefore
            )
        }
    }

    override func keyUp(with event: NSEvent) {
        guard let surface else {
            super.keyUp(with: event)
            return
        }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action = GHOSTTY_ACTION_RELEASE
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = modsFromEvent(event)
        keyEvent.consumed_mods = GHOSTTY_MODS_NONE
        keyEvent.composing = false
        keyEvent.text = nil
        keyEvent.unshifted_codepoint = unshiftedCodepoint(from: event)

        _ = ghostty_surface_key(surface, keyEvent)
    }

    override func flagsChanged(with event: NSEvent) {
        guard surface != nil else { return }

        // Don't send modifier events during IME composition
        if hasMarkedText() { return }

        // Determine which modifier this keyCode represents
        let mod: UInt32
        switch event.keyCode {
        case 0x39: mod = GHOSTTY_MODS_CAPS.rawValue
        case 0x38, 0x3C: mod = GHOSTTY_MODS_SHIFT.rawValue
        case 0x3B, 0x3E: mod = GHOSTTY_MODS_CTRL.rawValue
        case 0x3A, 0x3D: mod = GHOSTTY_MODS_ALT.rawValue
        case 0x37, 0x36: mod = GHOSTTY_MODS_SUPER.rawValue
        default: return
        }

        let mods = modsFromEvent(event)

        // If the modifier bit is set in current flags, it's a press; otherwise release.
        var action = GHOSTTY_ACTION_RELEASE
        if mods.rawValue & mod != 0 {
            // Check if the correct side is pressed for right-side keys
            let sidePressed: Bool
            switch event.keyCode {
            case 0x3C: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERSHIFTKEYMASK) != 0
            case 0x3E: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERCTLKEYMASK) != 0
            case 0x3D: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERALTKEYMASK) != 0
            case 0x36: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERCMDKEYMASK) != 0
            default: sidePressed = true
            }
            if sidePressed {
                action = GHOSTTY_ACTION_PRESS
            }
        }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action = action
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = mods
        keyEvent.consumed_mods = GHOSTTY_MODS_NONE
        keyEvent.composing = false
        keyEvent.text = nil
        keyEvent.unshifted_codepoint = 0
        _ = ghostty_surface_key(surface!, keyEvent)
    }

    /// Send a key event to the ghostty surface.
    private func sendKeyEvent(
        action: ghostty_input_action_e,
        event: NSEvent,
        text: String?,
        composing: Bool = false
    ) {
        guard let surface else { return }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action = action
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = modsFromEvent(event)
        // consumed_mods: modifiers that contributed to text translation.
        // Control and command never contribute to text translation.
        keyEvent.consumed_mods = modsFromFlags(
            event.modifierFlags.subtracting([.control, .command])
        )
        keyEvent.composing = composing
        keyEvent.unshifted_codepoint = unshiftedCodepoint(from: event)

        // Filter text: don't send control characters (Ghostty handles those
        // via keycode+mods) or PUA function key codepoints.
        let filteredText = filterKeyText(text)

        if let filteredText, !filteredText.isEmpty {
            filteredText.withCString { ptr in
                keyEvent.text = ptr
                _ = ghostty_surface_key(surface, keyEvent)
            }
        } else {
            keyEvent.text = nil
            _ = ghostty_surface_key(surface, keyEvent)
        }
    }

    /// Filter text for key events: strip control characters and PUA function keys.
    private func filterKeyText(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }

        if text.count == 1, let scalar = text.unicodeScalars.first {
            // Control characters — Ghostty encodes these from keycode+mods
            if scalar.value < 0x20 { return nil }
            // macOS PUA range for function keys (arrows, F-keys, etc.)
            if scalar.value >= 0xF700 && scalar.value <= 0xF8FF { return nil }
        }

        return text
    }

    /// Sync preedit (IME composition) state to the ghostty surface.
    private func syncPreedit(clearIfNeeded: Bool = true) {
        guard let surface else { return }

        if markedText.length > 0 {
            let str = markedText.string
            str.withCString { ptr in
                ghostty_surface_preedit(surface, ptr, UInt(str.utf8.count))
            }
        } else if clearIfNeeded {
            ghostty_surface_preedit(surface, nil, 0)
        }
    }

    // MARK: - Mouse Input

    override func mouseDown(with event: NSEvent) {
        guard let surface else { return }
        window?.makeFirstResponder(self)
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, modsFromEvent(event))
    }

    override func mouseUp(with event: NSEvent) {
        guard let surface else { return }
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, modsFromEvent(event))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let surface else { return }
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
    }

    override func mouseMoved(with event: NSEvent) {
        guard let surface else { return }
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
    }

    override func mouseEntered(with event: NSEvent) {
        guard let surface else { return }
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
    }

    override func mouseExited(with event: NSEvent) {
        guard let surface else { return }
        // Send position outside the surface to indicate mouse left
        ghostty_surface_mouse_pos(surface, -1, -1, modsFromEvent(event))
    }

    override func rightMouseDown(with event: NSEvent) {
        guard let surface else { return }
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, modsFromEvent(event))
    }

    override func rightMouseUp(with event: NSEvent) {
        guard let surface else { return }
        let pos = mousePos(from: event)
        ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, modsFromEvent(event))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }

        let x = event.scrollingDeltaX
        let y = event.scrollingDeltaY

        // Build scroll mods (precision scrolling flag in bit 0)
        var scrollMods: Int32 = 0
        if event.hasPreciseScrollingDeltas {
            scrollMods |= 1
        }

        ghostty_surface_mouse_scroll(surface, x, y, scrollMods)
    }

    // MARK: - Paste

    @objc func paste(_ sender: Any?) {
        guard let surface else { return }
        guard let string = NSPasteboard.general.string(forType: .string) else { return }
        string.withCString { ptr in
            ghostty_surface_text(surface, ptr, UInt(string.utf8.count))
        }
    }

    // MARK: - Helpers

    private func modsFromEvent(_ event: NSEvent) -> ghostty_input_mods_e {
        return modsFromFlags(event.modifierFlags)
    }

    private func modsFromFlags(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods: UInt32 = GHOSTTY_MODS_NONE.rawValue
        if flags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { mods |= GHOSTTY_MODS_CAPS.rawValue }

        // Sided modifier detection
        let rawFlags = flags.rawValue
        if rawFlags & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { mods |= GHOSTTY_MODS_SHIFT_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERCTLKEYMASK) != 0 { mods |= GHOSTTY_MODS_CTRL_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERALTKEYMASK) != 0 { mods |= GHOSTTY_MODS_ALT_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERCMDKEYMASK) != 0 { mods |= GHOSTTY_MODS_SUPER_RIGHT.rawValue }

        return ghostty_input_mods_e(rawValue: mods)
    }

    private func mousePos(from event: NSEvent) -> CGPoint {
        // isFlipped = true, so the coordinate system is already top-down (y=0 at top).
        return convert(event.locationInWindow, from: nil)
    }

    private func unshiftedCodepoint(from event: NSEvent) -> UInt32 {
        // Use characters(byApplyingModifiers:) with no modifiers to get the
        // true unshifted codepoint. charactersIgnoringModifiers changes behavior
        // with control pressed, which we don't want.
        guard event.type == .keyDown || event.type == .keyUp else { return 0 }
        guard let chars = event.characters(byApplyingModifiers: []),
              let scalar = chars.unicodeScalars.first else { return 0 }
        return scalar.value
    }

    private var boundsInPixels: CGSize {
        let scale = window?.backingScaleFactor ?? 2.0
        return CGSize(
            width: bounds.width * scale,
            height: bounds.height * scale
        )
    }
}

// MARK: - NSTextInputClient

extension GhosttySurfaceView: NSTextInputClient {
    func hasMarkedText() -> Bool {
        return markedText.length > 0
    }

    func markedRange() -> NSRange {
        guard markedText.length > 0 else { return NSRange() }
        return NSRange(location: 0, length: markedText.length)
    }

    func selectedRange() -> NSRange {
        return NSRange()
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        switch string {
        case let v as NSAttributedString:
            markedText = NSMutableAttributedString(attributedString: v)
        case let v as String:
            markedText = NSMutableAttributedString(string: v)
        default:
            break
        }

        // If we're not in a keyDown event, sync preedit immediately
        // (e.g. keyboard layout change during composition)
        if keyTextAccumulator == nil {
            syncPreedit()
        }
    }

    func unmarkText() {
        if markedText.length > 0 {
            markedText.mutableString.setString("")
            syncPreedit()
        }
    }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] {
        return []
    }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        return nil
    }

    func characterIndex(for point: NSPoint) -> Int {
        return 0
    }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface else {
            return NSRect(x: frame.origin.x, y: frame.origin.y, width: 0, height: 0)
        }

        var x: Double = 0
        var y: Double = 0
        var w: Double = 0
        var h: Double = 0
        ghostty_surface_ime_point(surface, &x, &y, &w, &h)

        // Ghostty coordinates are top-left origin; convert to bottom-left for AppKit
        let viewRect = NSRect(x: x, y: frame.size.height - y, width: 0, height: h)
        let winRect = convert(viewRect, to: nil)
        guard let window else { return winRect }
        return window.convertToScreen(winRect)
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        guard NSApp.currentEvent != nil else { return }

        let chars: String
        switch string {
        case let v as NSAttributedString:
            chars = v.string
        case let v as String:
            chars = v
        default:
            return
        }

        // Clear any preedit state
        unmarkText()

        // If we're inside keyDown processing, accumulate for later
        if var acc = keyTextAccumulator {
            acc.append(chars)
            keyTextAccumulator = acc
            return
        }

        // Direct text insertion (e.g. from services or dictation)
        guard let surface else { return }
        chars.withCString { ptr in
            ghostty_surface_text(surface, ptr, UInt(chars.utf8.count))
        }
    }

    override func doCommand(by selector: Selector) {
        // Prevent NSBeep for unhandled selectors.
        // If we're inside a keyDown, the key event will be sent after
        // interpretKeyEvents returns (with no accumulated text).
    }
}
