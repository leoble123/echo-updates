import AppKit
import SwiftUI

// MARK: - Bits

struct HealthDot: View {
    let color: Color
    var body: some View {
        Circle().fill(color).frame(width: 10, height: 10)
            .shadow(color: color.opacity(0.6), radius: 4)
    }
}

struct MemoryBar: View {
    let title: String
    let mb: Int?
    let limit: Int?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text(mb.map { "\($0) MB" } ?? "-").foregroundStyle(.secondary).monospacedDigit()
            }
            if let limit, let mb {
                let f = min(1, Double(mb) / Double(limit))
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.quaternary)
                        Capsule().fill(f > 0.85 ? Color.orange : Color.accentColor).frame(width: g.size.width * f)
                    }
                }
                .frame(height: 6)
            }
        }
    }
}

func ago(_ d: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f.localizedString(for: d, relativeTo: Date())
}

func uptime(_ s: Int) -> String {
    if s < 3600 { return "\(s / 60) min" }
    if s < 86400 { return "\(s / 3600) h \(s % 3600 / 60) min" }
    return "\(s / 86400) d \(s % 86400 / 3600) h"
}

// MARK: - Menu bar

struct MenuPanel: View {
    @EnvironmentObject var brain: Brain
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                HealthDot(color: brain.healthColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(brain.healthTitle).font(.headline)
                    Text(brain.healthDetail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            if brain.engineAnswering {
                VStack(spacing: 8) {
                    MemoryBar(title: "Engine", mb: brain.status.serverMb, limit: brain.status.serverLimitMb)
                    MemoryBar(title: "Messages", mb: brain.status.messagesMb, limit: brain.status.messagesLimitMb)
                }
                .font(.caption)
            }
            if brain.updateAvailable {
                Button {
                    brain.update()
                } label: {
                    Label(brain.updating ? "Updating…" : "Update to build \(brain.latestBuild ?? 0)", systemImage: "arrow.down.circle.fill")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderedProminent)
                .disabled(brain.updating)
            }
            Divider()
            Group {
                Button("Open Echo…") { openWindow(id: "main"); Dock.show() }
                Button("Restart Messages") { brain.restartMessages() }
                Button("Restart Engine") { brain.restartEngine() }
                Button("Received Files") { brain.openDownloads() }
            }
            .buttonStyle(.plain)
            Divider()
            Button("Quit Echo (messages keep working)") { NSApp.terminate(nil) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(width: 290)
        .onAppear { brain.refresh() }
    }
}

// MARK: - Window

enum Pane: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case connection = "Connection"
    case features = "Features"
    case files = "Files"
    case phone = "Your Phone"
    case backups = "Backups"
    case settings = "Settings"
    case updates = "Updates"
    case logs = "Logs"
    var id: Pane { self }
    var symbol: String {
        switch self {
        case .overview: return "gauge.with.dots.needle.67percent"
        case .connection: return "antenna.radiowaves.left.and.right"
        case .features: return "sparkles"
        case .files: return "folder"
        case .phone: return "iphone"
        case .backups: return "externaldrive.badge.timemachine"
        case .settings: return "gearshape"
        case .updates: return "arrow.down.circle"
        case .logs: return "doc.text.magnifyingglass"
        }
    }
}

struct MainWindow: View {
    @EnvironmentObject var brain: Brain
    @State private var section: Pane? = .overview

    var body: some View {
        NavigationSplitView {
            List(Pane.allCases, selection: $section) { s in
                Label(s.rawValue, systemImage: s.symbol)
                    .badge(s == .updates && brain.updateAvailable ? 1 : 0)
            }
            .navigationSplitViewColumnWidth(190)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    switch section ?? .overview {
                    case .overview: OverviewPane()
                    case .connection: ConnectionPane()
                    case .features: FeaturesPane()
                    case .files: FilesPane()
                    case .phone: PhonePane()
                    case .backups: BackupsPane()
                    case .settings: SettingsPane()
                    case .updates: UpdatesPane()
                    case .logs: LogsPane()
                    }
                    if let note = brain.note {
                        Text(note).font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(24)
                .frame(maxWidth: 720, alignment: .leading)
            }
        }
    }
}

struct Card<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct Row: View {
    let title: String
    let value: String
    var good: Bool? = nil
    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if let good { Image(systemName: good ? "checkmark.circle.fill" : "exclamationmark.triangle.fill").foregroundStyle(good ? .green : .orange) }
            Text(value).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
}

struct OverviewPane: View {
    @EnvironmentObject var brain: Brain
    var body: some View {
        HStack(spacing: 14) {
            HealthDot(color: brain.healthColor).scaleEffect(1.6)
            VStack(alignment: .leading) {
                Text(brain.healthTitle).font(.largeTitle.weight(.bold))
                Text(brain.healthDetail).foregroundStyle(.secondary)
            }
        }
        if case .attention = brain.health { PermissionsCard() }
        if case .down = brain.health {
            Button("Start the engine") { brain.restartEngine() }.buttonStyle(.borderedProminent)
        }
        let s = brain.status
        Card(title: "MEMORY") {
            MemoryBar(title: "Echo engine", mb: s.serverMb, limit: s.serverLimitMb)
            MemoryBar(title: "Messages", mb: s.messagesMb, limit: s.messagesLimitMb)
            MemoryBar(title: "Find My", mb: s.findMyMb, limit: nil)
            MemoryBar(title: "FaceTime", mb: s.faceTimeMb, limit: nil)
        }
        Card(title: "THIS MAC") {
            Row(title: "Free space", value: s.freeDiskGb.map { String(format: "%.1f GB", $0) } ?? "-")
            Row(title: "Messages history", value: s.messagesGb.map { String(format: "%.1f GB", $0) } ?? "Measuring…")
            Row(title: "Engine up for", value: uptime(s.uptimeSec))
            Row(title: "Engine version", value: s.version.isEmpty ? "-" : "\(s.version) · build \(brain.installedBuild.map(String.init) ?? "?")")
        }
        Card(title: "ECHO GUARD") {
            if s.events.isEmpty {
                Text("Nothing has needed fixing.").foregroundStyle(.secondary)
            } else {
                ForEach(Array(s.events.suffix(8).reversed().enumerated()), id: \.offset) { item in
                    HStack(alignment: .top) {
                        Text(item.element.1)
                        Spacer()
                        Text(ago(item.element.0)).foregroundStyle(.secondary).font(.caption)
                    }
                }
            }
        }
        HStack {
            Button("Restart Messages") { brain.restartMessages() }
            Button("Restart Engine") { brain.restartEngine() }
        }
    }
}

struct PermissionsCard: View {
    @EnvironmentObject var brain: Brain
    private func open(_ pane: String) {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
    }
    var body: some View {
        Card(title: "PERMISSIONS") {
            Row(title: "Full Disk Access (reads your messages)", value: "", good: brain.status.fullDisk)
            if !brain.status.fullDisk {
                Button("Open Full Disk Access…") { open("Privacy_AllFiles") }
                Text("Switch on Echo Server, then Restart Engine.").font(.caption).foregroundStyle(.secondary)
            }
            Row(title: "Accessibility (optional)", value: "", good: brain.status.accessibility)
            if !brain.status.accessibility { Button("Open Accessibility…") { open("Privacy_Accessibility") } }
            Row(title: "Private API", value: brain.status.privateApi ? "Connected" : "Not connected", good: brain.status.privateApi)
        }
    }
}

struct ConnectionPane: View {
    @EnvironmentObject var brain: Brain
    var body: some View {
        let s = brain.status
        Text("Connection").font(.largeTitle.weight(.bold))
        Card(title: "YOUR ADDRESS") {
            Row(title: "Phones and browsers reach this Mac at", value: s.address.isEmpty ? "-" : s.address)
            Row(title: "Through", value: s.proxy.isEmpty ? "-" : s.proxy)
            if !s.address.isEmpty {
                Button("Copy Address") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(s.address, forType: .string)
                }
            }
        }
        Card(title: "DEVICES") {
            Row(title: "Live connections right now", value: "\(s.liveClients)")
            Row(title: "Browsers getting notifications", value: "\(s.pushSubscribers)")
        }
        Card(title: "TYPING INDICATORS") {
            Row(title: "Others typing, heard from Messages", value: s.typingLastHeard.map { "\(s.typingHeard) · \(ago($0))" } ?? "Never", good: s.typingHeard > 0)
            Row(title: "Yours, sent", value: "\(s.typingSent)")
            Button("Show a Test Bubble on My Devices") { brain.testTyping() }
            Text(s.typingHeard == 0
                 ? "Typing comes from the Private API helper inside Messages. If someone types to you and this stays at Never, try Restart Messages."
                 : "Typing is reaching Echo. If a phone still doesn't show it, its live connection is the place to look.")
                .font(.caption).foregroundStyle(.secondary)
        }
        PermissionsCard()
    }
}

struct FeaturesPane: View {
    @EnvironmentObject var brain: Brain
    @State private var key = ""
    var body: some View {
        Text("Features").font(.largeTitle.weight(.bold))
        Card(title: "UNIVERSAL CLIPBOARD") {
            Toggle("Share the clipboard with your phone and Echo Web", isOn: Binding(
                get: { brain.clipboardOn ?? false },
                set: { brain.setClipboard($0) }
            ))
            .disabled(brain.clipboardOn == nil)
            Text("Passwords copied from a password manager are never sent.").font(.caption).foregroundStyle(.secondary)
        }
        Card(title: "REMINDERS & NOTES") {
            ForEach(["Reminders", "Notes"], id: \.self) { name in
                Row(title: name, value: brain.appsCheck[name] ?? "Not checked", good: brain.appsCheck[name].map { $0.hasPrefix("Working") })
            }
            HStack {
                Button("Check Now") { brain.checkMacApps() }
                Button("Open Automation Settings…") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!)
                }
            }
            Text("Your phone reaches Reminders and Notes through Echo Server. If macOS asks whether Echo Server may control them, click Allow; if you clicked Don't Allow, switch them on under Automation → Echo Server.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Card(title: "CATCH ME UP (CLAUDE)") {
            if brain.aiConfigured == true {
                Row(title: "Anthropic API key", value: "Set", good: true)
                Button("Remove Key", role: .destructive) { brain.setAIKey("") }
            } else {
                HStack {
                    SecureField("sk-ant-…", text: $key).textFieldStyle(.roundedBorder)
                    Button("Save") { brain.setAIKey(key); key = "" }.disabled(key.count < 20)
                }
                Text("Stored on this Mac only, never sent to your devices.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct FilesPane: View {
    @EnvironmentObject var brain: Brain
    var body: some View {
        Text("Files").font(.largeTitle.weight(.bold))
        Card(title: "BETWEEN THIS MAC AND YOUR DEVICES") {
            Text("Files sent from your phone or Echo Web land in Downloads/Echo. Put files in Downloads/Echo/Send to Phone and they go to your phone (and show in Echo Web) for a day.")
            Button("Open Downloads/Echo") { brain.openDownloads() }
        }
    }
}

struct PhonePane: View {
    @EnvironmentObject var brain: Brain
    @State private var ringing = false

    private func ago(_ d: Date) -> String {
        let m = Int(Date().timeIntervalSince(d) / 60)
        return m < 1 ? "just now" : m < 60 ? "\(m) min ago" : "\(m / 60) h ago"
    }

    var body: some View {
        Text(brain.phone?.name ?? "Your Phone").font(.largeTitle.weight(.bold))
        if let p = brain.phone {
            Card(title: "RIGHT NOW · UPDATED \(ago(p.at).uppercased())") {
                Row(title: "Battery", value: p.battery.map { "\($0)%\(p.charging ? " · charging" : "")" } ?? "Unknown")
                Row(title: "Network", value: p.network == "wifi" ? "Wi-Fi" : p.network == "cellular" ? (p.carrier ?? "Cellular") : "Offline")
                Row(title: "Signal", value: p.signal.map { "\($0) of 4 bars" } ?? "Unknown")
                Row(title: "Hotspot", value: p.hotspot.map { $0 ? "On" : "Off" } ?? "Your phone doesn't say")
            }
        } else {
            Card(title: "NOT HEARD FROM YET") {
                Text("Open Echo on your phone (1.19 or later) with Settings → Your Computer → Share Battery & Signal on.")
                    .foregroundStyle(.secondary)
            }
        }
        Card(title: "FIND MY PHONE") {
            Text("Rings at full volume, even on silent, for a minute - or until you tap Found It.").foregroundStyle(.secondary)
            Button(ringing ? "Stop Ringing" : "Ring My Phone") {
                brain.ringPhone(stop: ringing)
                ringing.toggle()
            }
            .buttonStyle(.borderedProminent)
            .tint(ringing ? .red : .accentColor)
        }
        Card(title: "NOTIFICATIONS ON YOUR PHONE") {
            Toggle("Show them on this Mac too", isOn: Binding(
                get: { (brain.settings["echo_phone_notifications_mac"] as? Bool) ?? true },
                set: { brain.saveSettings(["echo_phone_notifications_mac": $0]) }
            ))
            if brain.phoneNotes.isEmpty {
                Text("None right now. On your phone: Settings → Your Computer → Phone Notifications on Computer.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(brain.phoneNotes) { n in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(n.appName).font(.caption).foregroundStyle(.secondary)
                            if !n.title.isEmpty { Text(n.title).font(.body.weight(.semibold)) }
                            if !n.text.isEmpty { Text(n.text).font(.callout).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Button { brain.dismissPhoneNote(n.id) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                            .help("Dismiss on your phone")
                    }
                    Divider()
                }
                Button("Clear All") { brain.dismissPhoneNote(nil) }
            }
        }
        .onAppear { brain.loadSettings() }
        .task {
            // Live while you look at it.
            while !Task.isCancelled {
                await brain.refreshPhone()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }
}

struct UpdatesPane: View {
    @EnvironmentObject var brain: Brain
    var body: some View {
        Text("Updates").font(.largeTitle.weight(.bold))
        Card(title: "ECHO ENGINE AND APP") {
            Row(title: "Installed", value: brain.installedBuild.map { "Build \($0)" } ?? "Unknown")
            Row(title: "Newest", value: brain.latestBuild.map { "Build \($0)" } ?? "Checking…")
            Toggle("Install updates automatically (overnight)", isOn: $brain.autoUpdate)
            HStack {
                Button(brain.updating ? "Updating…" : (brain.updateAvailable ? "Update Now" : "Reinstall")) { brain.update() }
                    .buttonStyle(.borderedProminent)
                    .disabled(brain.updating)
                Button("Check Again") { Task { await brain.checkForUpdates() } }
            }
        }
        if !brain.updateLog.isEmpty {
            Card(title: "PROGRESS") {
                Text(brain.updateLog.suffix(4000))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct LogsPane: View {
    @EnvironmentObject var brain: Brain
    @State private var text = ""
    var body: some View {
        HStack {
            Text("Logs").font(.largeTitle.weight(.bold))
            Spacer()
            Button("Refresh") { text = brain.recentLog() }
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([Paths.engineLog]) }
        }
        Text(text)
            .font(.system(.caption2, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { text = brain.recentLog() }
    }
}

struct BackupsPane: View {
    @EnvironmentObject var brain: Brain
    @State private var showKey = false

    private func bytes(_ v: Any?) -> String {
        let n = (v as? NSNumber)?.int64Value ?? 0
        return ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
    }

    var body: some View {
        Text("Backups").font(.largeTitle.weight(.bold))
            .onAppear { brain.loadBackupInfo() }
        Card(title: "WHAT GETS BACKED UP") {
            Row(title: "Messages database", value: bytes(brain.backupInfo["dbBytes"]))
            Row(title: "Attachments", value: "\((brain.backupInfo["attachmentsCount"] as? NSNumber)?.intValue ?? 0) files · \(bytes(brain.backupInfo["attachmentsBytes"]))")
            Row(title: "Last pulled by your PC", value: (brain.backupInfo["lastPulled"] as? NSNumber).map { ago(Date(timeIntervalSince1970: $0.doubleValue / 1000)) } ?? "Never")
            Text("Your PC pulls these every night: a fresh copy of the messages database, plus any new attachments. Everything is encrypted here before it leaves this Mac. To set it up, open Echo on the PC → Your Mac → Back Up to This PC.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Card(title: "RECOVERY KEY") {
            let key = EngineConfig.read()?.backupKey ?? ""
            if key.isEmpty {
                Text("Made the first time the engine starts with backups. Check back in a minute.").foregroundStyle(.secondary)
            } else {
                Text(showKey ? key : String(repeating: "•", count: 32))
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                HStack {
                    Button(showKey ? "Hide" : "Show Key") { showKey.toggle() }
                    Button("Copy Key") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(key, forType: .string)
                        brain.note = "Key copied. Keep it in a password manager - without it the backups can't be opened."
                    }
                }
                Text("The backups on your PC are locked with this key. If this Mac is ever lost, you'll need it to restore them - save it in a password manager now. It never leaves this Mac on its own.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
