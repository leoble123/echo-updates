import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// The engine's settings - what BlueBubbles' own window used to hold, and only what matters.
struct SettingsPane: View {
    @EnvironmentObject var brain: Brain
    @State private var method = "cloudflare"
    @State private var ownAddress = ""
    @State private var ngrokToken = ""
    @State private var ngrokDomain = ""
    @State private var zrokToken = ""
    @State private var port = ""
    @State private var serverLimit = 900.0
    @State private var messagesLimit = 1400.0
    @State private var loaded = false
    @State private var confirmPassword = false

    private func bool(_ k: String) -> Bool {
        let v = brain.settings[k]
        return (v as? Bool) ?? ((v as? NSNumber)?.boolValue ?? false)
    }

    private func toggle(_ title: String, _ key: String) -> some View {
        Toggle(title, isOn: Binding(get: { bool(key) }, set: { brain.saveSettings([key: $0]) }))
    }

    private func fill() {
        let s = brain.settings
        guard !s.isEmpty, !loaded else { return }
        loaded = true
        // Older builds wrote "Cloudflare" and "Dynamic DNS"; the picker knows the lowercase names.
        let raw = (s["proxy_service"] as? String ?? "cloudflare").lowercased().replacingOccurrences(of: " ", with: "-")
        method = ["cloudflare", "ngrok", "zrok", "dynamic-dns", "lan-url"].contains(raw) ? raw : "cloudflare"
        ownAddress = s["server_address"] as? String ?? ""
        ngrokDomain = s["ngrok_custom_domain"] as? String ?? ""
        port = "\(s["socket_port"] as? NSNumber ?? 1234)"
        serverLimit = Double(s["echo_server_limit_mb"] as? String ?? "") ?? 900
        messagesLimit = Double(s["echo_messages_limit_mb"] as? String ?? "") ?? 1400
    }

    private func applyAddress() {
        var c: [String: Any] = ["proxy_service": method]
        switch method {
        case "dynamic-dns", "lan-url":
            guard ownAddress.hasPrefix("http") else { brain.note = "The address must start with http:// or https://"; return }
            c["server_address"] = ownAddress
        case "ngrok":
            if !ngrokToken.isEmpty { c["ngrok_key"] = ngrokToken }
            c["ngrok_custom_domain"] = ngrokDomain
        case "zrok":
            if !zrokToken.isEmpty { c["zrok_token"] = zrokToken }
        default: break
        }
        brain.saveSettings(c, done: "Address settings saved. Your devices are told about the new address automatically.")
        ngrokToken = ""; zrokToken = ""
    }

    var body: some View {
        Text("Settings").font(.largeTitle.weight(.bold))
            .onAppear { brain.loadSettings() }
            .onChange(of: brain.settings.count) { _ in fill() }

        PairingCard()
        BrowsersCard()

        Card(title: "HOW DEVICES REACH THIS MAC") {
            Picker("Address", selection: $method) {
                Text("Cloudflare (free, changes when the engine restarts)").tag("cloudflare")
                Text("ngrok (permanent with a free account)").tag("ngrok")
                Text("zrok").tag("zrok")
                Text("My own address (your domain, Tailscale…)").tag("dynamic-dns")
                Text("Home network only").tag("lan-url")
            }
            switch method {
            case "dynamic-dns", "lan-url":
                TextField("https://messages.example.com", text: $ownAddress).textFieldStyle(.roundedBorder)
            case "ngrok":
                SecureField(bool("ngrok_key_set") ? "Auth token (set - leave blank to keep)" : "ngrok auth token", text: $ngrokToken)
                    .textFieldStyle(.roundedBorder)
                TextField("Custom domain (optional), e.g. you.ngrok.app", text: $ngrokDomain).textFieldStyle(.roundedBorder)
            case "zrok":
                SecureField(bool("zrok_token_set") ? "Token (set - leave blank to keep)" : "zrok token", text: $zrokToken)
                    .textFieldStyle(.roundedBorder)
            default:
                EmptyView()
            }
            toggle("If Tailscale goes offline, use Cloudflare until it's back", "echo_address_standin")
            HStack {
                Button("Apply") { applyAddress() }.buttonStyle(.borderedProminent).disabled(brain.savingSettings)
                Text("Now: \(brain.status.address.isEmpty ? "-" : brain.status.address)")
                    .foregroundStyle(.secondary).textSelection(.enabled).lineLimit(1)
            }
        }

        Card(title: "MESSAGES") {
            toggle("Private API (typing, tapbacks, edits, replies)", "enable_private_api")
            toggle("FaceTime Private API (calls from Echo)", "enable_ft_private_api")
            toggle("FaceTime calling", "facetime_calling")
            toggle("Keep this Mac awake", "auto_caffeinate")
            toggle("Copy login codes automatically", "echo_auto_codes")
        }

        Card(title: "ECHO GUARD") {
            toggle("Watch and heal the engine and Messages", "echo_guard")
            Text("No nightly restart: Echo Guard only steps in when something goes wrong - the engine or Messages growing too big, the API not answering, or the Private API dropping (it reconnects just the helper first).")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Text("Engine memory limit")
                Slider(value: $serverLimit, in: 400...3000, step: 100, onEditingChanged: { editing in
                    if !editing { brain.saveSettings(["echo_server_limit_mb": Int(serverLimit)]) }
                })
                Text("\(Int(serverLimit)) MB").monospacedDigit().frame(width: 70, alignment: .trailing)
            }
            HStack {
                Text("Messages memory limit")
                Slider(value: $messagesLimit, in: 600...4000, step: 100, onEditingChanged: { editing in
                    if !editing { brain.saveSettings(["echo_messages_limit_mb": Int(messagesLimit)]) }
                })
                Text("\(Int(messagesLimit)) MB").monospacedDigit().frame(width: 70, alignment: .trailing)
            }
        }

        Card(title: "ADVANCED") {
            HStack {
                Text("Port")
                TextField("1234", text: $port).textFieldStyle(.roundedBorder).frame(width: 90)
                Button("Apply") { brain.saveSettings(["socket_port": Int(port) ?? 1234], done: "Port changed - the engine is restarting its connections.") }
            }
            HStack {
                Button(confirmPassword ? "Click again: every device must re-pair" : "Make a New Password…", role: .destructive) {
                    if confirmPassword { brain.newPassword(); confirmPassword = false } else { confirmPassword = true }
                }
                Text("If someone else may have seen your pairing code.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// A QR code a phone or browser scans to connect, the same format BlueBubbles used.
struct PairingCard: View {
    @EnvironmentObject var brain: Brain
    @State private var revealed = false

    private func qr(_ text: String) -> NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: out)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }

    private func code(_ p: (password: String, address: String)) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [p.password, p.address])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    var body: some View {
        Card(title: "PAIR A PHONE OR BROWSER") {
            if let p = brain.pairing {
                HStack(alignment: .top, spacing: 18) {
                    ZStack {
                        if let img = qr(code(p)) {
                            Image(nsImage: img).interpolation(.none).resizable().frame(width: 180, height: 180)
                                .blur(radius: revealed ? 0 : 12)
                        }
                        if !revealed {
                            Button("Show Code") { revealed = true }.buttonStyle(.borderedProminent)
                        }
                    }
                    .frame(width: 180, height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 8) {
                        Text("In Echo on your phone: Settings → Connection to Your Mac → Scan Server QR Code. For a browser, use a link code from the phone instead (Settings → Echo on the Web) - it never gets this password.")
                        Button("Copy Setup Code") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(code(p), forType: .string)
                            brain.note = "Setup code copied - it contains your password, so only paste it into your own devices."
                        }
                        Text("Hidden until you click, because it contains your server password.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("Waiting for the engine's address…").foregroundStyle(.secondary)
            }
        }
    }
}

/// Echo Web browsers linked with a code from the phone. Each has its own key,
/// so signing one out here locks it out at once - the password stays the same.
struct BrowsersCard: View {
    @EnvironmentObject var brain: Brain

    private func when(_ ms: Double) -> String {
        guard ms > 0 else { return "never" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
    }

    var body: some View {
        Card(title: "LINKED BROWSERS") {
            if brain.browsers.isEmpty {
                Text("No browsers linked with a code. Link one from your phone: Settings → Echo on the Web.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(brain.browsers.indices, id: \.self) { i in
                    let b = brain.browsers[i]
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(b["name"] as? String ?? "Browser")
                            Text("Last seen \(when((b["seenAt"] as? NSNumber)?.doubleValue ?? 0))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Sign Out") { brain.revokeBrowsers([b["id"] as? String ?? ""]) }
                    }
                }
                Button("Sign Out All Browsers") { brain.revokeBrowsers(nil) }
            }
            Text("Browsers set up with the setup code above hold the server password itself - to sign those out, choose a new password.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onAppear { brain.loadBrowsers() }
    }
}
