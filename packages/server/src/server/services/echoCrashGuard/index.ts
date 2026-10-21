import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { EchoGuard } from "@server/services/echoGuard";

type Sent = { at: number; hash: string; preview: string };

/**
 * Some messages crash Messages when the Private API helper sends them (a
 * link scan on macOS 27.2 did), and a phone retrying the send crashed it
 * again, every time. This notices: a send through the helper, then a
 * Messages crash report written within the minute, marks that message. Sent
 * again, it goes the plain way (AppleScript) - no effect or reply, but it
 * goes, and Messages stays up.
 */
export class EchoCrashGuard {
    private static recent: Sent[] = [];

    /** Message hashes to keep away from the helper, until when. */
    private static poisoned = new Map<string, number>();

    private static lastCrash = 0;

    private static scannedAt = 0;

    private static dirs = [
        path.join(os.homedir(), "Library", "Logs", "DiagnosticReports"),
        "/Library/Logs/DiagnosticReports"
    ];

    static hash(chatGuid: string, text: string): string {
        return crypto.createHash("sha1").update(`${chatGuid}\u0000${text ?? ""}`).digest("hex");
    }

    /** The newest Messages crash report, by when it was written. */
    private static newestCrash(): number {
        let newest = 0;
        for (const dir of EchoCrashGuard.dirs) {
            let names: string[] = [];
            try {
                names = fs.readdirSync(dir);
            } catch {
                continue;
            }
            for (const n of names) {
                if (!/^Messages[-_ ].*\.(ips|crash)$/i.test(n)) continue;
                try {
                    newest = Math.max(newest, fs.statSync(path.join(dir, n)).mtimeMs);
                } catch {
                    /* gone already */
                }
            }
        }
        return newest;
    }

    /** Looks for a new crash and blames the send just before it. Cheap; at most every few seconds. */
    static scan() {
        const now = Date.now();
        if (now - EchoCrashGuard.scannedAt < 3000) return;
        EchoCrashGuard.scannedAt = now;
        const crash = EchoCrashGuard.newestCrash();
        if (!crash || crash <= EchoCrashGuard.lastCrash) return;
        const first = EchoCrashGuard.lastCrash === 0;
        EchoCrashGuard.lastCrash = crash;
        // The reports already there when the engine started aren't news.
        if (first && now - crash > 5 * 60_000) return;
        const culprit = [...EchoCrashGuard.recent].reverse().find(s => s.at <= crash + 2000 && crash - s.at < 60_000);
        if (!culprit) return;
        if ((EchoCrashGuard.poisoned.get(culprit.hash) ?? 0) > now) return;
        EchoCrashGuard.poisoned.set(culprit.hash, now + 24 * 3600_000);
        EchoGuard.record(`Messages crashed sending “${culprit.preview}”. If it's sent again it goes the plain way, so Messages stays up`);
    }

    /** Whether this message should stay away from the helper. */
    static avoidHelper(chatGuid: string, text: string): boolean {
        EchoCrashGuard.scan();
        const until = EchoCrashGuard.poisoned.get(EchoCrashGuard.hash(chatGuid, text)) ?? 0;
        return until > Date.now();
    }

    /** A message is about to go through the helper. */
    static sending(chatGuid: string, text: string) {
        const t = String(text ?? "");
        EchoCrashGuard.recent.push({
            at: Date.now(),
            hash: EchoCrashGuard.hash(chatGuid, t),
            preview: t.length > 40 ? `${t.slice(0, 40)}…` : t || "an attachment"
        });
        if (EchoCrashGuard.recent.length > 30) EchoCrashGuard.recent.shift();
    }
}
