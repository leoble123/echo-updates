import Foundation
import SQLite3

/// Where the engine keeps its settings, logs and our own bits.
enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static let engineData = home.appendingPathComponent("Library/Application Support/bluebubbles-server")
    static let config = engineData.appendingPathComponent("config.db")
    static let engineLog = home.appendingPathComponent("Library/Logs/bluebubbles-server/main.log")
    static let serviceLog = home.appendingPathComponent("Library/Logs/Echo/server.log")
    static let echoData = home.appendingPathComponent("Library/Application Support/Echo")
    static let installedBuild = echoData.appendingPathComponent("installed-build")
    static let downloads = home.appendingPathComponent("Downloads/Echo")
    static let engineApp = URL(fileURLWithPath: "/Applications/Echo Server.app")
    static let engineLabel = "com.echo.server"
}

/// The engine's own settings, read straight from its config database.
struct EngineConfig {
    var password: String
    var port: Int
    /** The key backups are encrypted with; read here, never over the network. */
    var backupKey: String = ""

    static func read() -> EngineConfig? {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(Paths.config.path, &db, flags, nil) == SQLITE_OK else {
            sqlite3_close(db)
            return nil
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 2000)
        var values: [String: String] = [:]
        var stmt: OpaquePointer?
        let sql = "SELECT name, value FROM config WHERE name IN ('password', 'socket_port', 'echo_backup_key')"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let n = sqlite3_column_text(stmt, 0) else { continue }
            let v = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            values[String(cString: n)] = v
        }
        guard let password = values["password"], !password.isEmpty else { return nil }
        return EngineConfig(password: password, port: Int(values["socket_port"] ?? "") ?? 1234, backupKey: values["echo_backup_key"] ?? "")
    }
}

struct EngineError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Talks to the engine's local API, the same one the phone and Echo Web use.
struct EngineAPI {
    let config: EngineConfig

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 15
        c.connectionProxyDictionary = [:]
        return URLSession(configuration: c)
    }()

    private func url(_ path: String, _ query: [String: String] = [:]) -> URL {
        var c = URLComponents(string: "http://127.0.0.1:\(config.port)/api/v1\(path)")!
        c.queryItems = [URLQueryItem(name: "password", value: config.password)]
            + query.map { URLQueryItem(name: $0.key, value: $0.value) }
        return c.url!
    }

    /// The `data` of the server's `{status, data}` envelope.
    func call(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil, timeout: TimeInterval = 15) async throws -> Any? {
        var req = URLRequest(url: url(path, query))
        req.httpMethod = method
        req.timeoutInterval = timeout
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await Self.session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let status = json?["status"] as? Int ?? code
        guard (200..<300).contains(code), (200..<300).contains(status) else {
            let err = (json?["error"] as? [String: Any])?["error"] as? String
                ?? (json?["error"] as? [String: Any])?["message"] as? String
                ?? json?["message"] as? String
            throw EngineError(message: err ?? "The engine answered HTTP \(code)")
        }
        return json?["data"]
    }
}

/// What the engine reports about itself (GET /echo/status).
struct EngineStatus {
    var version = ""
    var uptimeSec = 0
    var serverMb: Int?
    var messagesMb: Int?
    var findMyMb: Int?
    var faceTimeMb: Int?
    var serverLimitMb = 900
    var messagesLimitMb = 1400
    var freeDiskGb: Double?
    var messagesGb: Double?
    var privateApi = false
    var pushSubscribers = 0
    var liveClients = 0
    var fullDisk = true
    var accessibility = true
    var address = ""
    var proxy = ""
    var typingHeard = 0
    var typingLastHeard: Date?
    var typingSent = 0
    var events: [(Date, String)] = []

    init() {}

    init(_ j: [String: Any]) {
        func int(_ d: [String: Any]?, _ k: String) -> Int? { (d?[k] as? NSNumber)?.intValue }
        func date(_ v: Any?) -> Date? { (v as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } }
        version = j["version"] as? String ?? ""
        uptimeSec = int(j, "uptimeSec") ?? 0
        let mem = j["memoryMb"] as? [String: Any]
        serverMb = int(mem, "server"); messagesMb = int(mem, "messages")
        findMyMb = int(mem, "findMy"); faceTimeMb = int(mem, "faceTime")
        let limits = j["limitsMb"] as? [String: Any]
        serverLimitMb = int(limits, "server") ?? 900
        messagesLimitMb = int(limits, "messages") ?? 1400
        freeDiskGb = (j["freeDiskGb"] as? NSNumber)?.doubleValue
        messagesGb = (j["messagesGb"] as? NSNumber)?.doubleValue
        privateApi = j["privateApi"] as? Bool ?? false
        pushSubscribers = int(j, "pushSubscribers") ?? 0
        liveClients = int(j, "liveClients") ?? 0
        let perms = j["permissions"] as? [String: Any]
        fullDisk = perms?["fullDisk"] as? Bool ?? true
        accessibility = perms?["accessibility"] as? Bool ?? true
        address = j["address"] as? String ?? ""
        proxy = j["proxy"] as? String ?? ""
        let t = j["typing"] as? [String: Any]
        typingHeard = int(t, "heard") ?? 0
        typingLastHeard = date(t?["lastHeardAt"])
        typingSent = int(t, "sent") ?? 0
        events = (j["events"] as? [[String: Any]] ?? []).compactMap { e in
            guard let at = date(e["at"]), let text = e["text"] as? String else { return nil }
            return (at, text)
        }
    }
}

/// Runs a command and hands back what it printed.
@discardableResult
func run(_ path: String, _ args: [String]) -> (status: Int32, output: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

/// The engine as a launchd service: whether it's running, and starting or restarting it.
enum EngineService {
    static var domain: String { "gui/\(getuid())" }

    static var isRunning: Bool {
        run("/usr/bin/pgrep", ["-f", "Echo Server.app/Contents/MacOS/Echo Server"]).status == 0
    }

    static var isInstalled: Bool { FileManager.default.fileExists(atPath: Paths.engineApp.path) }

    /// Starts it if it's stopped, restarts it if it's running.
    static func restart() {
        let r = run("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(Paths.engineLabel)"])
        if r.status != 0 {
            let plist = Paths.home.appendingPathComponent("Library/LaunchAgents/\(Paths.engineLabel).plist").path
            run("/bin/launchctl", ["bootstrap", domain, plist])
        }
    }

    static var installedBuild: Int? {
        (try? String(contentsOf: Paths.installedBuild, encoding: .utf8))
            .flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
}
