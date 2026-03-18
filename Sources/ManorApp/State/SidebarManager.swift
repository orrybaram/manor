import Combine
import Foundation

@MainActor
final class SidebarManager: ObservableObject {
    @Published var sidebarVisible: Bool = true
    @Published var sidebarWidth: CGFloat = {
        let saved = UserDefaults.standard.double(forKey: "sidebarWidth")
        return saved > 0 ? CGFloat(saved) : LayoutConstants.sidebarDefaultWidth
    }()

    func toggleSidebar() {
        sidebarVisible.toggle()
    }
}
