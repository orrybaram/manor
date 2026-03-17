import AppKit
#if canImport(CGhosttyKit)
import CGhosttyKit
#endif

// MARK: - C Callback Functions
// These are @convention(c) compatible free functions passed to ghostty_runtime_config_s.

/// Called when ghostty needs the app to process events on the main thread.
func ghosttyWakeup(_ userdata: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async {
        GhosttyApp.shared.tick()
    }
}

/// Called when ghostty performs an action (split, title change, notification, etc).
func ghosttyAction(
    _ app: ghostty_app_t?,
    _ target: ghostty_target_s,
    _ action: ghostty_action_s
) -> Bool {
    let ghosttyApp = GhosttyApp.shared

    // Dispatch to main thread if needed
    if !Thread.isMainThread {
        var result = false
        DispatchQueue.main.sync {
            result = ghosttyApp.delegate?.ghosttyApp(ghosttyApp, didReceiveAction: action, target: target) ?? false
        }
        return result
    }

    return ghosttyApp.delegate?.ghosttyApp(ghosttyApp, didReceiveAction: action, target: target) ?? false
}

/// Called when ghostty wants to read from the clipboard.
func ghosttyReadClipboard(
    _ userdata: UnsafeMutableRawPointer?,
    _ location: ghostty_clipboard_e,
    _ state: UnsafeMutableRawPointer?
) -> Bool {
    guard let state else { return false }

    let pasteboard: NSPasteboard
    switch location {
    case GHOSTTY_CLIPBOARD_STANDARD:
        pasteboard = .general
    case GHOSTTY_CLIPBOARD_SELECTION:
        return false // macOS doesn't have a selection clipboard
    default:
        return false
    }

    guard let content = pasteboard.string(forType: .string) else {
        return false
    }

    // Get the surface from userdata to complete the request
    if let userdata {
        let surface = Unmanaged<AnyObject>.fromOpaque(userdata).takeUnretainedValue()
        if let surfacePtr = surface as? GhosttySurfaceView {
            content.withCString { ptr in
                ghostty_surface_complete_clipboard_request(surfacePtr.surface, ptr, state, false)
            }
            return true
        }
    }

    return false
}

/// Called when ghostty wants to write to the clipboard.
func ghosttyWriteClipboard(
    _ userdata: UnsafeMutableRawPointer?,
    _ location: ghostty_clipboard_e,
    _ contents: UnsafePointer<ghostty_clipboard_content_s>?,
    _ count: Int,
    _ confirmation: Bool
) {
    guard location == GHOSTTY_CLIPBOARD_STANDARD else { return }
    guard let contents, count > 0 else { return }

    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()

    // Use the first content item
    let content = contents.pointee
    if let data = content.data {
        pasteboard.setString(String(cString: data), forType: .string)
    }
}

/// Called when ghostty wants to close a surface.
func ghosttyCloseSurface(
    _ userdata: UnsafeMutableRawPointer?,
    _ needsConfirm: Bool
) {
    guard let userdata else { return }

    DispatchQueue.main.async {
        let ghosttyApp = GhosttyApp.shared
        // userdata here is the surface's userdata (the GhosttySurfaceView pointer)
        let view = Unmanaged<GhosttySurfaceView>.fromOpaque(userdata).takeUnretainedValue()
        if let surface = view.surface {
            ghosttyApp.delegate?.ghosttyApp(ghosttyApp, closeSurface: surface, needsConfirm: needsConfirm)
        }
    }
}
