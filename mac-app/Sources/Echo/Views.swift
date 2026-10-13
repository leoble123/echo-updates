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
    case updates = "Updates"
    case logs = "Logs"
    var id: Pane { self }
    var symbol: String {
        switch self {
        case .overview: return "gauge.with.dots.needle.67percent"
        case .connection: return "antenna.radiowaves.left.and.right"
        case .features: return "sparkles"
        case .files: return "folder"
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
