import Foundation

package struct ActivePort: Hashable, Identifiable {
    package var id: UInt16 { port }
    package let port: UInt16
    package let processName: String
    package let pid: pid_t
    package var worktreePath: String?
}

package final class ActivePortScanner {
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "com.manor.port-scanner", qos: .utility)
    package var onPortsChanged: (([ActivePort]) -> Void)?
    private var ports: [ActivePort] = []
    private var worktreePaths: [String] = []

    package init() {}

    package func start(interval: TimeInterval = 3.0) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler { [weak self] in
            self?.scan()
        }
        self.timer = timer
        timer.resume()
    }

    package func stop() {
        timer?.cancel()
        timer = nil
    }

    /// Thread-safe worktree path update — dispatches to the scanner queue so reads
    /// and writes always happen on the same serial queue.
    package func updateWorktreePaths(_ paths: [String]) {
        queue.async { [weak self] in
            self?.worktreePaths = paths
        }
    }

    private func scan() {
        let uid = getuid()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-a", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn", "-u", "\(uid)"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return }

        var filtered = Self.parse(output)

        // Resolve which worktree each port belongs to
        let knownWorktreePaths = worktreePaths
        if !knownWorktreePaths.isEmpty && !filtered.isEmpty {
            let cwds = Self.cwdsByPID(for: filtered.map { $0.pid })
            for i in filtered.indices {
                let cwd = cwds[filtered[i].pid] ?? ""
                let best = knownWorktreePaths.max {
                    let aMatches = cwd.hasPrefix($0)
                    let bMatches = cwd.hasPrefix($1)
                    if aMatches && bMatches { return $0.count < $1.count }
                    return bMatches && !aMatches
                }
                if let best = best, cwd.hasPrefix(best) {
                    filtered[i].worktreePath = best
                }
            }
        }

        // Only show ports whose CWD matches a real project worktree (not just
        // the home directory, which is the broad fallback and matches everything).
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        filtered = filtered.filter { port in
            guard let path = port.worktreePath else { return false }
            return path != homeDir
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if filtered != self.ports {
                self.ports = filtered
                self.onPortsChanged?(filtered)
            }
        }
    }

    /// Returns a map of PID → current working directory path.
    private static func cwdsByPID(for pids: [pid_t]) -> [pid_t: String] {
        guard !pids.isEmpty else { return [:] }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        let pidList = pids.map { "\($0)" }.joined(separator: ",")
        process.arguments = ["-a", "-p", pidList, "-d", "cwd", "-nP", "-F", "pn"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return [:]
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [:] }

        var result: [pid_t: String] = [:]
        var currentPID: pid_t = 0
        parseLsofOutput(output) { prefix, value in
            switch prefix {
            case "p": currentPID = pid_t(value) ?? 0
            case "n": if currentPID != 0 { result[currentPID] = value }
            default: break
            }
        }
        return result
    }

    package static func parse(_ output: String) -> [ActivePort] {
        var results: [ActivePort] = []
        var seenPorts: Set<UInt16> = []
        var currentPID: pid_t = 0
        var currentCommand: String = ""

        parseLsofOutput(output) { prefix, value in
            switch prefix {
            case "p":
                currentPID = pid_t(value) ?? 0
            case "c":
                currentCommand = value
            case "n":
                // Format: "*:3000" or "127.0.0.1:3000" or "[::1]:3000"
                if let colonIdx = value.lastIndex(of: ":") {
                    let portStr = String(value[value.index(after: colonIdx)...])
                    if let port = UInt16(portStr), !seenPorts.contains(port) {
                        seenPorts.insert(port)
                        results.append(ActivePort(
                            port: port,
                            processName: currentCommand,
                            pid: currentPID
                        ))
                    }
                }
            default:
                break
            }
        }

        return results.sorted { $0.port < $1.port }
    }

    /// Iterates lsof `-F` format output, calling `processor` with (fieldKey, value) for each line.
    private static func parseLsofOutput(_ output: String, processor: (Character, String) -> Void) {
        for line in output.components(separatedBy: "\n") {
            guard !line.isEmpty, let prefix = line.first else { continue }
            processor(prefix, String(line.dropFirst()))
        }
    }
}
