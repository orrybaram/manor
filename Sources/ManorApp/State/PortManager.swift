import AppKit
import Combine
import ManorCore

@MainActor
final class PortManager: ObservableObject {
    @Published var activePorts: [ActivePort] = []

    let portScanner = ActivePortScanner()

    func startPortScanner() {
        portScanner.onPortsChanged = { [weak self] ports in
            self?.activePorts = ports
        }
        portScanner.start()
    }

    func updateWorktreePaths(_ paths: [String]) {
        portScanner.updateWorktreePaths(paths)
    }

    func clickPort(_ port: ActivePort) {
        if let url = URL(string: "http://localhost:\(port.port)") {
            NSWorkspace.shared.open(url)
        }
    }
}
