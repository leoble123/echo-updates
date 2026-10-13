import AppKit
import SwiftUI

@main
struct EchoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var brain = Brain()

    var body: some Scene {
        MenuBarExtra {
            MenuPanel().environmentObject(brain)
        } label: {
            Image(systemName: brain.menuSymbol)
        }
        .menuBarExtraStyle(.window)

        Window("Echo", id: "main") {
            MainWindow()
                .environmentObject(brain)
                .frame(minWidth: 760, minHeight: 520)
                .onAppear { brain.windowOpen = true; Dock.show() }
                .onDisappear { brain.windowOpen = false; Dock.hide() }
        }
        .defaultSize(width: 880, height: 620)
    }
}

/// Echo lives in the menu bar; it gets a Dock icon only while its window is open.
enum Dock {
    @MainActor static func show() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    @MainActor static func hide() {
        NSApp.setActivationPolicy(.accessory)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    // Closing the window keeps Echo in the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

extension Brain {
    var menuSymbol: String {
        switch health {
        case .good: return "bubble.left.and.bubble.right.fill"
        case .checking: return "bubble.left.and.bubble.right"
        case .attention: return "exclamationmark.bubble.fill"
        case .down, .notInstalled: return "bubble.left.and.exclamationmark.bubble.right"
        }
    }

    var engineAnswering: Bool {
        switch health {
        case .good, .attention: return true
        default: return false
        }
    }

    var healthColor: Color {
        switch health {
        case .good: return .green
        case .checking: return .secondary
        case .attention: return .orange
        case .down, .notInstalled: return .red
        }
    }

    var healthTitle: String {
        switch health {
        case .good: return "Echo is running"
        case .checking: return "Checking…"
        case .attention: return "Echo needs you"
        case .down: return "Echo isn't answering"
        case .notInstalled: return "The engine isn't installed"
        }
    }

    var healthDetail: String {
        switch health {
        case .good:
            let devices = status.liveClients
            return "Private API on · \(devices) live connection\(devices == 1 ? "" : "s")"
        case .checking: return " "
        case .attention(let why), .down(let why): return why
        case .notInstalled: return "Run the Echo installer on this Mac."
        }
    }
}
