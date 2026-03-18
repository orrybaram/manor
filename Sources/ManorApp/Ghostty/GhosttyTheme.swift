import AppKit
import CGhosttyKit

/// Derived UI chrome colors built from the user's Ghostty terminal theme.
struct GhosttyTheme {
    let terminalBackground: NSColor
    let terminalForeground: NSColor

    // MARK: - Derived Colors

    var sidebarBackground: NSColor { terminalBackground }

    var tabBarBackground: NSColor { terminalBackground.adjustedBrightness(by: 0.02) }

    var selectedTabBackground: NSColor { terminalBackground.adjustedBrightness(by: 0.08) }

    var hoverBackground: NSColor { terminalBackground.adjustedBrightness(by: 0.05) }

    var selectedBackground: NSColor { terminalBackground.adjustedBrightness(by: 0.10) }

    var dividerColor: NSColor { terminalBackground.adjustedBrightness(by: 0.10) }

    var primaryText: NSColor { terminalForeground.withAlphaComponent(0.70) }

    var selectedText: NSColor { terminalForeground }

    var dimText: NSColor { terminalForeground.withAlphaComponent(0.40) }

    // MARK: - Construction

    static func load(from config: ghostty_config_t) -> GhosttyTheme {
        let bg = readColor(from: config, key: "background") ?? Self.default.terminalBackground
        let fg = readColor(from: config, key: "foreground") ?? Self.default.terminalForeground
        return GhosttyTheme(terminalBackground: bg, terminalForeground: fg)
    }

    static var `default`: GhosttyTheme {
        GhosttyTheme(
            terminalBackground: NSColor(srgbRed: 0.10, green: 0.10, blue: 0.10, alpha: 1),
            terminalForeground: NSColor(srgbRed: 0.95, green: 0.95, blue: 0.95, alpha: 1)
        )
    }

    // MARK: - Private

    private static func readColor(from config: ghostty_config_t, key: String) -> NSColor? {
        var color = ghostty_config_color_s()
        let ok = ghostty_config_get(config, &color, key, UInt(key.lengthOfBytes(using: .utf8)))
        guard ok else { return nil }
        return NSColor(
            srgbRed: CGFloat(color.r) / 255,
            green: CGFloat(color.g) / 255,
            blue: CGFloat(color.b) / 255,
            alpha: 1
        )
    }
}

// MARK: - NSColor brightness helper

private extension NSColor {
    /// Adjusts HSB brightness by `delta`, clamped to [0, 1]. Works for both dark and light colors.
    func adjustedBrightness(by delta: CGFloat) -> NSColor {
        guard let srgb = usingColorSpace(.sRGB) else { return self }
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        srgb.getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        let newB = max(0, min(1, b + delta))
        return NSColor(hue: h, saturation: s, brightness: newB, alpha: a)
    }
}
