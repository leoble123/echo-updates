import SwiftUI

/// One build of Echo for Mac and its engine, as someone using it would put it.
struct MacRelease: Identifiable {
    let build: Int
    let date: String
    let headline: String
    let changes: [String]
    var id: Int { build }
}

/// What every build changed, newest first. Written by hand, for whoever uses
/// Echo, not whoever maintains it. Add the next build at the top in the same
/// commit that ships it.
enum WhatsNew {
    static let releases: [MacRelease] = [
        MacRelease(build: 43, date: "21 October 2026", headline: "Your address stays the one you picked.", changes: [
            "Fixed: choosing My own address (your Tailscale one) could flip back to Cloudflare. The Tailscale check misread a working Tailscale as offline and switched to the backup tunnel; it now trusts this Mac's Tailscale connection itself.",
            "Picking an address method yourself is final - an earlier automatic switch can no longer undo it.",
            "New switch under How Devices Reach This Mac: use Cloudflare only while Tailscale is offline. Turn it off and your address never changes on its own.",
        ]),
        MacRelease(build: 42, date: "21 October 2026", headline: "Echo on two devices, one alert.", changes: [
            "Your phones and tablets check in with this Mac, so only the one you're using rings - the others get the message quietly. Read a conversation or swipe its alert away on one, and it clears on the rest, even with read receipts off.",
        ]),
        MacRelease(build: 41, date: "20 October 2026", headline: "Reachable even when Tailscale isn't.", changes: [
            "If Tailscale goes offline for ten minutes, Echo Server switches to a Cloudflare tunnel on its own and your phone follows it there. When Tailscale is back, your permanent address is put back.",
        ]),
        MacRelease(build: 40, date: "20 October 2026", headline: "Stickers land where they were put.", changes: [
            "When someone drops a sticker on a message, Echo Server now tells your phone exactly where - so it shows on the bubble at that spot, size and angle, like on an iPhone.",
        ]),
        MacRelease(build: 39, date: "19 October 2026", headline: "Browsers get their own keys.", changes: [
            "Linked Browsers, in Settings: every browser linked with a code from your phone, when it was last used, and a Sign Out that locks it out at once.",
            "A browser linked with a code gets a key of its own, never your server password - and it can't change the password or let other browsers in.",
            "Phones and browsers can send the password in a header instead of in web addresses, so it stays out of links.",
            "Echo Guard's helper repairs are now tested on every build.",
        ]),
        MacRelease(build: 38, date: "19 October 2026", headline: "What's New, and no more nightly restart setting.", changes: [
            "This page: what each update changed, shown once after Echo updates.",
            "The \"Fresh restart every night at 4am\" switch is gone. Echo no longer restarts anything at night - Echo Guard only steps in when something actually goes wrong.",
        ]),
        MacRelease(build: 37, date: "18 October 2026", headline: "No more 4 a.m. restart.", changes: [
            "The nightly restart is gone. It could come back without the Private API connected, and on a temporary address it moved your Mac somewhere your phone couldn't find it.",
            "When the Private API helper drops, Echo Guard reconnects just the helper - your address stays put. It only restarts the whole engine if that doesn't work, and never more than once every two hours.",
        ]),
        MacRelease(build: 36, date: "16 October 2026", headline: "Messages get through deep sleep.", changes: [
            "New messages are pushed to your phone at high priority, so they arrive even while Android is in deep sleep.",
        ]),
        MacRelease(build: 35, date: "16 October 2026", headline: "FaceTime status.", changes: [
            "Your phone can see whether FaceTime through the Mac is switched on and ready.",
        ]),
        MacRelease(build: 34, date: "15 October 2026", headline: "An address that looks after itself.", changes: [
            "Echo keeps its public address up on its own - if Tailscale Funnel switches off, it turns it back on.",
            "Your phone learns every way to reach this Mac, so it can fall back when one stops working.",
        ]),
        MacRelease(build: 33, date: "14 October 2026", headline: "Typing, always.", changes: [
            "Typing indicators reach your phone even when its live connection is down.",
        ]),
        MacRelease(build: 32, date: "14 October 2026", headline: "Instant messages.", changes: [
            "Messages arrive the moment they land, instead of in bursts.",
        ]),
        MacRelease(build: 31, date: "14 October 2026", headline: "Your phone on your computers.", changes: [
            "Your phone's battery, signal, hotspot and notifications on your Mac and PC, and Find My Phone.",
        ]),
        MacRelease(build: 30, date: "14 October 2026", headline: "Login codes.", changes: [
            "A login code that arrives is copied for you, ready to paste.",
        ]),
        MacRelease(build: 29, date: "14 October 2026", headline: "Fixes.", changes: [
            "A scheduled message that came due while Echo was restarting is sent, instead of expiring.",
            "Echo never quits an app you're using.",
        ]),
        MacRelease(build: 28, date: "14 October 2026", headline: "Scheduled messages and more, on the Mac.", changes: [
            "Scheduled messages, the Mac remote and Echo Wrapped run on the Mac itself.",
        ]),
        MacRelease(build: 27, date: "14 October 2026", headline: "Backups.", changes: [
            "The Backups pane: what's backed up, when your PC last pulled a copy, and your recovery key.",
        ]),
    ]

    private static let seenKey = "whatsNewSeenBuild"

    /// The build this copy of Echo is.
    static var currentBuild: Int {
        Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? (releases.first?.build ?? 0)
    }

    /// The newest build whose notes have been looked at. The first time
    /// What's New exists there's nothing recorded, so it starts just before
    /// this build: the newest notes show, the whole history doesn't.
    static var seenBuild: Int {
        let seen = UserDefaults.standard.integer(forKey: seenKey)
        return seen > 0 ? seen : currentBuild - 1
    }

    /// Notes for builds newer than the ones already read, up to this one.
    static var unseen: [MacRelease] {
        releases.filter { $0.build > seenBuild && $0.build <= max(currentBuild, releases.first?.build ?? 0) }
    }

    static func markSeen() {
        UserDefaults.standard.set(max(currentBuild, releases.first?.build ?? 0), forKey: seenKey)
    }
}

struct WhatsNewPane: View {
    @EnvironmentObject var brain: Brain
    var body: some View {
        Text("What's New").font(.largeTitle.weight(.bold))
        ForEach(WhatsNew.releases) { r in
            Card(title: "BUILD \(r.build) · \(r.date.uppercased())") {
                Text(r.headline).font(.headline)
                ForEach(r.changes, id: \.self) { change in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(change).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .onAppear { brain.markWhatsNewSeen() }
    }
}
