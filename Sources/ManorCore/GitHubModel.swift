import Foundation
import AppKit

// MARK: - PR Info

package struct GitHubPRInfo {
    package let number: Int
    package let state: PRState
    package let title: String

    package enum PRState: String {
        case open, closed, merged

        package var color: NSColor {
            switch self {
            case .open:   return NSColor(red: 0.23, green: 0.73, blue: 0.33, alpha: 1)
            case .merged: return NSColor(red: 0.53, green: 0.27, blue: 0.87, alpha: 1)
            case .closed: return NSColor(red: 0.55, green: 0.55, blue: 0.55, alpha: 1)
            }
        }
    }
}

// MARK: - Diff Stat

package struct DiffStat {
    package let additions: Int
    package let deletions: Int
}

// MARK: - GitHub Helper

package enum GitHubHelper {
    private static let additionsRegex = try! NSRegularExpression(pattern: #"(\d+) insertion"#)
    private static let deletionsRegex = try! NSRegularExpression(pattern: #"(\d+) deletion"#)

    package static func isGHAvailable() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = ["gh"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    /// Runs `gh pr view --json number,state,title` in the worktree directory.
    package static func prInfo(at worktreePath: String) -> GitHubPRInfo? {
        guard !worktreePath.isEmpty else { return nil }

        let process = Process()
        // gh may be in /usr/local/bin or /opt/homebrew/bin — use env to resolve
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["gh", "pr", "view", "--json", "number,state,title"]
        process.currentDirectoryURL = URL(fileURLWithPath: worktreePath)

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        guard process.terminationStatus == 0 else { return nil }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        guard
            let number = json["number"] as? Int,
            let stateStr = json["state"] as? String,
            let title = json["title"] as? String
        else { return nil }

        // gh returns "OPEN", "CLOSED", "MERGED" — lowercase for matching
        let state = GitHubPRInfo.PRState(rawValue: stateStr.lowercased()) ?? .closed

        return GitHubPRInfo(number: number, state: state, title: title)
    }

    /// Runs `git diff --shortstat origin/<baseBranch>...HEAD` and parses the result.
    package static func diffStat(at worktreePath: String, against baseBranch: String) -> DiffStat? {
        guard !worktreePath.isEmpty else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["diff", "--shortstat", "origin/\(baseBranch)...HEAD"]
        process.currentDirectoryURL = URL(fileURLWithPath: worktreePath)

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        guard process.terminationStatus == 0 else { return nil }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return nil }

        // "3 files changed, 245 insertions(+), 65 deletions(-)"
        let additions = parseCount(regex: additionsRegex, in: output)
        let deletions = parseCount(regex: deletionsRegex, in: output)

        guard additions > 0 || deletions > 0 else { return nil }
        return DiffStat(additions: additions, deletions: deletions)
    }

    // MARK: - Internal

    static func parseCount(regex: NSRegularExpression, in string: String) -> Int {
        guard let match = regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)),
              let range = Range(match.range(at: 1), in: string)
        else { return 0 }
        return Int(string[range]) ?? 0
    }
}
