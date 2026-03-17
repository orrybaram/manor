import AppKit
import CGhosttyKit

/// Singleton managing the ghostty application instance and configuration.
/// Must be initialized before any surfaces are created.
final class GhosttyApp {
    static let shared = GhosttyApp()

    private(set) var app: ghostty_app_t?
    private(set) var config: ghostty_config_t?

    /// Delegate for routing ghostty actions to the window controller.
    weak var delegate: GhosttyAppDelegate?

    private init() {
        initializeGhostty()
    }

    deinit {
        if let app { ghostty_app_free(app) }
        if let config { ghostty_config_free(config) }
    }

    // MARK: - Initialization

    private func initializeGhostty() {
        // Step 1: Library init
        let result = ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)
        guard result == GHOSTTY_SUCCESS else {
            NSLog("GhosttyApp: ghostty_init failed with code \(result)")
            return
        }

        // Step 2: Config
        guard let primaryConfig = ghostty_config_new() else {
            NSLog("GhosttyApp: ghostty_config_new failed")
            return
        }
        ghostty_config_load_default_files(primaryConfig)
        ghostty_config_load_recursive_files(primaryConfig)
        ghostty_config_finalize(primaryConfig)

        // Step 3: Runtime callbacks
        var rt = ghostty_runtime_config_s()
        rt.userdata = Unmanaged.passUnretained(self).toOpaque()
        rt.supports_selection_clipboard = false
        rt.wakeup_cb = ghosttyWakeup
        rt.action_cb = ghosttyAction
        rt.read_clipboard_cb = ghosttyReadClipboard
        rt.confirm_read_clipboard_cb = nil
        rt.write_clipboard_cb = ghosttyWriteClipboard
        rt.close_surface_cb = ghosttyCloseSurface

        // Step 4: Create app (with fallback)
        if let created = ghostty_app_new(&rt, primaryConfig) {
            self.app = created
            self.config = primaryConfig
        } else {
            NSLog("GhosttyApp: primary config failed, trying fallback")
            ghostty_config_free(primaryConfig)
            guard let fallback = ghostty_config_new() else { return }
            ghostty_config_finalize(fallback)
            self.app = ghostty_app_new(&rt, fallback)
            self.config = fallback
        }

        if app == nil {
            NSLog("GhosttyApp: failed to create ghostty app")
        }
    }

    // MARK: - Tick

    func tick() {
        guard let app else { return }
        ghostty_app_tick(app)
    }

    // MARK: - Surface Creation

    func newSurfaceConfig(context: ghostty_surface_context_e = GHOSTTY_SURFACE_CONTEXT_WINDOW) -> ghostty_surface_config_s {
        var sc = ghostty_surface_config_new()
        sc.context = context
        return sc
    }
}

// MARK: - Delegate Protocol

protocol GhosttyAppDelegate: AnyObject {
    func ghosttyApp(_ app: GhosttyApp, didReceiveAction action: ghostty_action_s, target: ghostty_target_s) -> Bool
    func ghosttyApp(_ app: GhosttyApp, closeSurface surface: ghostty_surface_t, needsConfirm: Bool)
}
