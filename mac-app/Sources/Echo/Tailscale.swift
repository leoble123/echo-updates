import AppKit
import Foundation

/// Keeps Tailscale open and connected - this Mac is only reachable at its
/// permanent address while it is. Every 30 seconds: Tailscale closed, it's
/// opened (hidden); open but disconnected, it's connected. Signed out is the
/// one thing it can't fix, so it says so.
@MainActor
final class TailscaleKeeper: ObservableObject {
    enum State: Equatable {
        case checking, notInstalled, connected, disconnected, signedOut, closed

        var text: String {
            switch self {
            case .checking: return "Checking…"
            case .notInstalled: return "Not installed"
            case .connected: return "Connected"
            case .disconnected: return "Disconnected"
            case .signedOut: return "Signed out - open Tailscale and sign in"
            case .closed: return "Not running"
            }
        }
    }

    @Published var state: State = .checking
    @Published var lastFix: (Date, String)?
    @Published var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "keepTailscaleOn")
            if enabled { check() }
        }
    }

    static let app = URL(fileURLWithPath: "/Applications/Tailscale.app")
    private static let bundleIds = ["io.tailscale.ipn.macos", "io.tailscale.ipn.macsys"]
    private var timer: Timer?
    private var fixing = false

    private var cli: String? {
        [Self.app.path + "/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    init() {
        UserDefaults.standard.register(defaults: ["keepTailscaleOn": true])
        enabled = UserDefaults.standard.bool(forKey: "keepTailscaleOn")
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.check() }
        }
        check()
    }

    private var appRunning: Bool {
        Self.bundleIds.contains { !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty }
    }

    func check() {
        guard let cli else { state = .notInstalled; return }
        let usesApp = cli.hasPrefix(Self.app.path)
        if usesApp && !appRunning {
            state = .closed
            if enabled { openApp() }
            return
        }
        Task.detached {
            let out = run(cli, ["status", "--json"]).output
            let backend = (try? JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])?["BackendState"] as? String
            await MainActor.run { self.landed(backend, cli: cli) }
        }
    }

    private func landed(_ backend: String?, cli: String) {
        switch backend ?? "" {
        case "Running": state = .connected
        case "NeedsLogin", "NeedsMachineAuth": state = .signedOut
        case "": state = appRunning ? .disconnected : .closed
        default: state = .disconnected
        }
        if enabled && state == .disconnected { connect(cli) }
    }

    /// Opens Tailscale out of sight; it connects by itself if it was connected before.
    func openApp() {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.hides = true
        NSWorkspace.shared.openApplication(at: Self.app, configuration: config) { _, _ in }
        lastFix = (Date(), "Opened Tailscale")
    }

    func connect(_ cli: String? = nil) {
        guard !fixing, let cli = cli ?? self.cli else { return }
        fixing = true
        Task.detached {
            let r = run(cli, ["up"])
            await MainActor.run {
                self.fixing = false
                self.lastFix = (Date(), r.status == 0 ? "Reconnected Tailscale" : "Tailscale wouldn't connect: \(r.output.prefix(120))")
                self.check()
            }
        }
    }

    /// The Fix button: whatever's wrong, the next step.
    func fix() {
        switch state {
        case .closed, .signedOut: openApp()
        case .disconnected: connect()
        case .notInstalled: NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
        default: check()
        }
    }
}
