import AppKit
import Foundation
import UserNotifications

/// Everything Echo knows and does, in one place the views watch.
@MainActor
final class Brain: ObservableObject {
    enum Health: Equatable {
        case checking
        /// Running and answering.
        case good
        /// Running and answering, but something needs you (a permission, the Private API).
        case attention(String)
        /// Starting up, or not answering.
        case down(String)
        /// The engine isn't on this Mac yet.
        case notInstalled
    }

    @Published var health: Health = .checking
    @Published var status = EngineStatus()
    @Published var lastChecked: Date?
    @Published var aiConfigured: Bool?
    @Published var clipboardOn: Bool?
    @Published var note: String?

    // Updates
    @Published var latestBuild: Int?
    @Published var installedBuild: Int? = EngineService.installedBuild
    @Published var updating = false
    @Published var updateLog = ""
    @Published var autoUpdate: Bool {
        didSet { UserDefaults.standard.set(autoUpdate, forKey: "autoUpdate") }
    }

    var updateAvailable: Bool {
        guard let latest = latestBuild else { return false }
        return latest > (installedBuild ?? 0)
    }

    private var api: EngineAPI?
    private var timer: Timer?
    private var downSince: Date?
    private var healedAt: Date?
    var windowOpen = false { didSet { if windowOpen { refresh() } ; schedule() } }

    init() {
        UserDefaults.standard.register(defaults: ["autoUpdate": true])
        autoUpdate = UserDefaults.standard.bool(forKey: "autoUpdate")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        schedule()
        refresh()
        Task { await checkForUpdates() }
        // Updates are looked for every few hours; installed overnight when automatic.
        Timer.scheduledTimer(withTimeInterval: 3 * 3600, repeats: true) { [weak self] _ in
            guard let brain = self else { return }
            Task { @MainActor in await brain.checkForUpdates() }
        }
    }

    private func schedule() {
        timer?.invalidate()
        // Quick while you're looking, relaxed otherwise.
        let every: TimeInterval = windowOpen ? 4 : 30
        timer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in
            guard let brain = self else { return }
            Task { @MainActor in brain.refresh() }
        }
    }

    func refresh() {
        Task { await poll() }
    }

    private func poll() async {
        guard EngineService.isInstalled else { health = .notInstalled; return }
        if api == nil, let cfg = EngineConfig.read() { api = EngineAPI(config: cfg) }
        guard let api else { health = .down("Waiting for the engine's settings"); return }
        do {
            let data = try await api.call("GET", "/echo/status", timeout: 8) as? [String: Any] ?? [:]
            status = EngineStatus(data)
            lastChecked = Date()
            downSince = nil
            if !status.fullDisk {
                health = .attention("Echo Server needs Full Disk Access to read your messages")
            } else if !status.privateApi {
                health = .attention("Private API isn't connected - no typing, tapbacks or edits")
            } else {
                health = .good
            }
            if aiConfigured == nil || windowOpen {
                aiConfigured = (try? await api.call("GET", "/echo/ai") as? [String: Any])?["configured"] as? Bool
                clipboardOn = (try? await api.call("GET", "/echo/clipboard") as? [String: Any])?["enabled"] as? Bool
            }
        } catch {
            // The password may have changed, or the port: read them again next time.
            self.api = nil
            let running = EngineService.isRunning
            health = .down(running ? "Starting up…" : "The engine isn't running")
            downSince = downSince ?? Date()
            heal(running: running)
        }
    }

    /// Down for two minutes: start it again, at most every five. launchd
    /// already restarts a crash; this catches the rest (stopped, hung).
    private func heal(running: Bool) {
        // An update stops and starts the engine itself.
        guard !updating, let since = downSince, Date().timeIntervalSince(since) > 120 else { return }
        if let healed = healedAt, Date().timeIntervalSince(healed) < 300 { return }
        healedAt = Date()
        EngineService.restart()
        notify("Echo restarted the engine", running ? "It stopped answering for two minutes." : "It had stopped.")
    }

    func notify(_ title: String, _ body: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // MARK: Actions

    func restartEngine() {
        note = "Restarting the engine… back in about 30 seconds."
        health = .down("Restarting…")
        Task.detached { EngineService.restart() }
    }

    func restartMessages() {
        note = "Restarting Messages…"
        Task {
            do {
                _ = try await api?.call("POST", "/mac/imessage/restart", body: [:], timeout: 60)
                note = "Messages restarted."
            } catch {
                note = "Couldn't restart Messages: \(error.localizedDescription)"
            }
        }
    }

    /// A pretend "typing…" on your phone and Echo Web, in your latest conversation.
    func testTyping() {
        Task {
            do {
                let r = try await api?.call("POST", "/echo/typing/test") as? [String: Any]
                note = "Look at \(r?["chat"] as? String ?? "your latest conversation") on your phone - the typing bubble shows for 8 seconds. If it doesn't, the phone's live connection is the problem."
            } catch {
                note = "Couldn't test: \(error.localizedDescription)"
            }
        }
    }

    @Published var appsCheck: [String: String] = [:]

    // MARK: Backups

    @Published var backupInfo: [String: Any] = [:]

    func loadBackupInfo() {
        Task {
            if let d = try? await api?.call("GET", "/echo/backup/info", timeout: 60) as? [String: Any] { backupInfo = d }
        }
    }

    // MARK: Engine settings

    @Published var settings: [String: Any] = [:]
    @Published var savingSettings = false

    /// The server password and address, for pairing a device.
    var pairing: (password: String, address: String)? {
        guard let cfg = EngineConfig.read(), !status.address.isEmpty else { return nil }
        return (cfg.password, status.address)
    }

    func loadSettings() {
        Task {
            if let d = try? await api?.call("GET", "/echo/settings") as? [String: Any] { settings = d }
        }
    }

    func saveSettings(_ changes: [String: Any], done: String = "Saved.") {
        savingSettings = true
        Task {
            do {
                _ = try await api?.call("POST", "/echo/settings", body: changes, timeout: 60)
                note = done
            } catch {
                note = "Couldn't save: \(error.localizedDescription)"
            }
            savingSettings = false
            loadSettings()
            refresh()
        }
    }

    /// A new random password. Every paired device has to scan the new code.
    func newPassword() {
        Task {
            do {
                _ = try await api?.call("POST", "/echo/password", body: [:])
                api = nil
                note = "New password set. Scan the new pairing code on each phone and browser."
                refresh()
            } catch {
                note = "Couldn't change the password: \(error.localizedDescription)"
            }
        }
    }

    /// Runs Reminders and Notes the way the phone does, and says exactly what happened.
    func checkMacApps() {
        appsCheck = ["Reminders": "Checking…", "Notes": "Checking…"]
        Task {
            for (name, path) in [("Reminders", "/echo/reminders"), ("Notes", "/echo/notes")] {
                do {
                    let r = try await api?.call("GET", path, query: ["fresh": "1"], timeout: 90)
                    if let d = r as? [String: Any] {
                        appsCheck[name] = "Working · \((d["reminders"] as? [Any])?.count ?? 0) to do in \((d["lists"] as? [Any])?.count ?? 0) lists"
                    } else if let a = r as? [Any] {
                        appsCheck[name] = "Working · \(a.count) notes"
                    } else {
                        appsCheck[name] = "Answered with nothing"
                    }
                } catch {
                    appsCheck[name] = "Error: \(error.localizedDescription)"
                }
            }
        }
    }

    func setAIKey(_ key: String) {
        Task {
            do {
                let r = try await api?.call("POST", "/echo/ai/key", body: ["key": key]) as? [String: Any]
                aiConfigured = r?["configured"] as? Bool
                note = key.isEmpty ? "Key removed." : "Saved. Catch me up is ready on your phone and Echo Web."
            } catch {
                note = error.localizedDescription
            }
        }
    }

    func setClipboard(_ on: Bool) {
        clipboardOn = on
        Task {
            do {
                let r = try await api?.call("POST", "/echo/clipboard/sync", body: ["enabled": on]) as? [String: Any]
                clipboardOn = r?["enabled"] as? Bool
            } catch {
                clipboardOn = !on
                note = error.localizedDescription
            }
        }
    }

    // MARK: Updates

    /// The newest engine build on GitHub (releases tagged server-<version>-<build>).
    func checkForUpdates() async {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/leoble123/echo-updates/releases?per_page=50")!)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let releases = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        let builds = releases.compactMap { r -> Int? in
            guard let tag = r["tag_name"] as? String, tag.hasPrefix("server-"),
                  let assets = r["assets"] as? [[String: Any]],
                  assets.contains(where: { ($0["name"] as? String)?.hasPrefix("EchoServer-") == true }) else { return nil }
            return Int(tag.split(separator: "-").last ?? "")
        }
        latestBuild = builds.max()
        installedBuild = EngineService.installedBuild
        if autoUpdate, updateAvailable, !updating {
            let hour = Calendar.current.component(.hour, from: Date())
            // Overnight, so a restart never lands mid-conversation.
            if (3...5).contains(hour) { update() }
        }
    }

    /// Runs the installer's update, which checks, signs and swaps in the new
    /// engine (and this app), the same way it was installed.
    func update() {
        guard !updating, let script = Bundle.main.url(forResource: "echo-server", withExtension: "sh") else {
            if Bundle.main.url(forResource: "echo-server", withExtension: "sh") == nil { note = "The updater is missing from this copy of Echo." }
            return
        }
        updating = true
        updateLog = ""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path, "update"]
        var env = ProcessInfo.processInfo.environment
        env["ECHO_FROM_APP"] = "1"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = String(data: h.availableData, encoding: .utf8) ?? ""
            // Progress bars redraw with \r; keep the text readable.
            let clean = chunk.replacingOccurrences(of: "\r", with: "\n")
            guard let brain = self else { return }
            Task { @MainActor in brain.updateLog += clean }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            let status = proc.terminationStatus
            guard let brain = self else { return }
            Task { @MainActor in
                brain.updating = false
                brain.installedBuild = EngineService.installedBuild
                if status == 0 {
                    brain.notify("Echo is up to date", "Build \(brain.installedBuild.map(String.init) ?? "?") is running.")
                    brain.relaunchIfReplaced()
                } else {
                    brain.note = "The update didn't finish - the old version is still running."
                }
            }
        }
        do { try p.run() } catch { updating = false; note = error.localizedDescription }
    }

    /// The updater may have put a newer Echo.app in place; switch to it.
    private func relaunchIfReplaced() {
        let running = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
        let onDisk = NSDictionary(contentsOf: Bundle.main.bundleURL.appendingPathComponent("Contents/Info.plist"))?["CFBundleVersion"] as? String
        guard let running, let onDisk, running != onDisk else { return }
        let path = Bundle.main.bundlePath
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open -g \"\(path)\""]
        try? p.run()
        NSApp.terminate(nil)
    }

    // MARK: Files and logs

    func openDownloads() {
        try? FileManager.default.createDirectory(at: Paths.downloads.appendingPathComponent("Send to Phone"), withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.downloads)
    }

    func recentLog(lines: Int = 300) -> String {
        guard let h = try? FileHandle(forReadingFrom: Paths.engineLog) else { return "No log yet." }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        let start = size > 200_000 ? size - 200_000 : 0
        try? h.seek(toOffset: start)
        let text = String(data: h.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
    }
}
