import AppKit
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

    override func keyDown(with event: NSEvent) {
        guard let surface else {
            super.keyDown(with: event)
            return
        }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = modsFromEvent(event)
        keyEvent.consumed_mods = GHOSTTY_MODS_NONE
        keyEvent.composing = false
        keyEvent.unshifted_codepoint = unshiftedCodepoint(from: event)

        let text = event.characters ?? ""
        if !text.isEmpty {
            text.withCString { ptr in
                keyEvent.text = ptr
                _ = ghostty_surface_key(surface, keyEvent)
            }
        } else {
            keyEvent.text = nil
            _ = ghostty_surface_key(surface, keyEvent)
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
        // GhosttyKit tracks modifier state internally via the mods in key events.
        // We don't need to do anything special here.
        super.flagsChanged(with: event)
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
        var mods: UInt32 = GHOSTTY_MODS_NONE.rawValue
        let flags = event.modifierFlags
        if flags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { mods |= GHOSTTY_MODS_CAPS.rawValue }
        return ghostty_input_mods_e(rawValue: mods)
    }

    private func mousePos(from event: NSEvent) -> CGPoint {
        let local = convert(event.locationInWindow, from: nil)
        // Flip y: AppKit is bottom-up, ghostty expects top-down
        return CGPoint(x: local.x, y: bounds.height - local.y)
    }

    private func unshiftedCodepoint(from event: NSEvent) -> UInt32 {
        guard let chars = event.charactersIgnoringModifiers,
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
