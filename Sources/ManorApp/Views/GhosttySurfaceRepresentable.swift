import SwiftUI
import ManorCore

/// Bridges GhosttySurfaceView (AppKit/Metal) into SwiftUI.
///
/// Critical invariant: a GhosttySurfaceView must never be destroyed and recreated
/// by SwiftUI's view diffing. Each representable should be given `.id(paneID.id)`
/// so SwiftUI treats it as a stable identity across re-renders.
struct GhosttySurfaceRepresentable: NSViewRepresentable {
    let paneID: PaneID
    @EnvironmentObject var appState: AppState

    func makeNSView(context: Context) -> GhosttySurfaceView {
        // Return existing instance — never create a new one for an existing pane
        if let existing = appState.paneSurfaces[paneID] {
            return existing
        }
        let view = GhosttySurfaceView(frame: .zero)
        view.paneID = paneID
        appState.paneSurfaces[paneID] = view
        // Flush any pending surface that was queued before this view existed
        appState.paneManager.surfaceViewDidRegister(paneID)
        return view
    }

    func updateNSView(_ nsView: GhosttySurfaceView, context: Context) {
        // Surface lifecycle is managed by AppState — nothing to update here
    }
}
