// swift-tools-version:5.9
import PackageDescription

// Echo for Mac: the app you see. The engine (Echo Server) does the iMessage
// work as a background service; this is where you watch it, control it,
// update it and use Echo's own features.
let package = Package(
    name: "Echo",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Echo",
            path: "Sources/Echo",
            linkerSettings: [.linkedLibrary("sqlite3")]
        )
    ]
)
