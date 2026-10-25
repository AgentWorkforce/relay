import Foundation
import Darwin
import RelayDesktopCore

enum SessionDesktopLauncher {
    /// Claude rejects redirected output for --desktop. Give it a real TTY
    /// without showing a terminal window, sending keystrokes, or changing sessions.
    static func launch(_ command: String, timeout: TimeInterval = 20) async -> String? {
        await Task.detached(priority: .userInitiated) {
            var master: Int32 = -1
            var slave: Int32 = -1
            guard openpty(&master, &slave, nil, nil, nil) == 0 else {
                return "Couldn’t prepare the Claude Desktop connection. Use Open in Terminal as an alternative."
            }
            defer { close(master) }
            let terminal = FileHandle(fileDescriptor: slave, closeOnDealloc: true)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lic", command]
            var environment = ProcessInfo.processInfo.environment
            environment["TERM"] = "xterm-256color"
            environment["NO_COLOR"] = "1"
            process.environment = environment
            process.standardInput = terminal
            process.standardOutput = terminal
            process.standardError = terminal
            do {
                try process.run()
                try terminal.close()
                _ = fcntl(master, F_SETFL, O_NONBLOCK)
                let deadline = ProcessInfo.processInfo.systemUptime + timeout
                var timedOut = false
                var output = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let now = ProcessInfo.processInfo.systemUptime
                    if now >= deadline && process.isRunning {
                        if !timedOut { process.terminate(); timedOut = true }
                        if now >= deadline + 1 { kill(process.processIdentifier, SIGKILL) }
                    }
                    var descriptor = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
                    _ = poll(&descriptor, 1, 100)
                    let count = Darwin.read(master, &buffer, buffer.count)
                    if count > 0 {
                        // Drain all output so the child cannot block on a full TTY.
                        output.append(contentsOf: buffer.prefix(min(count, max(0, 4000 - output.count))))
                    } else if count < 0 && (errno == EINTR || errno == EAGAIN) {
                        if !process.isRunning { break }
                        continue
                    }
                    else {
                        // The child can close its terminal before exiting. Keep
                        // enforcing the deadline rather than blocking in waitUntilExit.
                        if !process.isRunning { break }
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                }
                process.waitUntilExit()
                if timedOut { return "Claude Desktop didn’t respond in time. Use Open in Terminal as an alternative." }
                guard process.terminationStatus != 0 else { return nil }
                let detail = String(decoding: output, as: UTF8.self)
                    .replacingOccurrences(of: "\u{001B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return SessionOpening.desktopFailure(detail)
            } catch {
                return "\(error.localizedDescription) Use Open in Terminal as an alternative."
            }
        }.value
    }
}
