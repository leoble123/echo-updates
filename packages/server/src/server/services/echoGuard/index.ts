import { app } from "electron";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { Loggable } from "@server/lib/logging/Loggable";
import { EchoMacApps } from "@server/services/echoMacApps";

/**
 * Echo Guard keeps the server healthy on a small Mac without anyone watching it.
 *
 * Once a minute it:
 *  - relaunches the server if its own memory stays too high, or if the API stops answering;
 *  - restarts Messages if it bloats (the Private API loop relaunches it with the helper);
 *  - reconnects the Private API helper if it has been gone for five minutes, and
 *    relaunches the server only if that doesn't work (at most once every two hours);
 *  - quits Find My and FaceTime when they are left running in the background;
 *  - clears the server's attachment caches when the disk gets tight.
 *
 * There is no nightly relaunch any more. A relaunch the server didn't need was
 * the riskiest thing it did: the helper didn't always come back after one, and
 * on a temporary address it moved the server somewhere the phone couldn't find.
 * The memory limits above already catch anything that leaks.
 *
 * Everything it does is written to the server log under "EchoGuard".
 */
const HELPER_REASON = "the Private API helper didn't come back after reconnecting";
const HELPER_RELAUNCH = `Relaunching: ${HELPER_REASON}`;

export class EchoGuard extends Loggable {
    tag = "EchoGuard";

    private timer: NodeJS.Timeout = null;

    private startedAt = Date.now();

    private strikes = { self: 0, messages: 0, api: 0, helper: 0 };

    /** Helper reconnects tried since it was last seen connected. */
    private helperRepairs = 0;

    /**
     * When the server was last relaunched over the helper, from the saved
     * history so it holds across the relaunch itself: once every two hours at most.
     */
    private static get helperRelaunchedAt() {
        const last = [...EchoGuard.events].reverse().find(e => e.text.startsWith(HELPER_RELAUNCH));
        return last?.at ?? 0;
    }

    /** What Echo Guard has done recently, newest last (for the Echo apps' status screen). */
    static events: { at: number; text: string }[] = [];

    private static get eventsFile() {
        return path.join(FileSystem.baseDir, "echo", "guard-events.json");
    }

    /** Kept on disk, so a relaunch Echo Guard caused still shows up after it. */
    static loadEvents() {
        try {
            EchoGuard.events = JSON.parse(fs.readFileSync(EchoGuard.eventsFile, "utf8")).slice(-30);
        } catch {
            EchoGuard.events = [];
        }
    }

    /** For other Echo services: something worth showing in Echo Guard's history. */
    static record(text: string) {
        EchoGuard.events.push({ at: Date.now(), text });
        if (EchoGuard.events.length > 30) EchoGuard.events.shift();
        try {
            fs.mkdirSync(path.dirname(EchoGuard.eventsFile), { recursive: true });
            fs.writeFileSync(EchoGuard.eventsFile, JSON.stringify(EchoGuard.events));
        } catch {
            // Only history.
        }
    }

    private note(text: string) {
        this.log.info(text);
        EchoGuard.events.push({ at: Date.now(), text });
        if (EchoGuard.events.length > 30) EchoGuard.events.shift();
        try {
            fs.mkdirSync(path.dirname(EchoGuard.eventsFile), { recursive: true });
            fs.writeFileSync(EchoGuard.eventsFile, JSON.stringify(EchoGuard.events));
        } catch {
            // Only history.
        }
    }

    /** The latest memory reading, in MB. */
    static lastReading: {
        server: number;
        messages: number;
        findMy: number;
        faceTime: number;
        freeDiskGb: number;
    } = null;

    /** Size of ~/Library/Messages (texts and attachments), in GB; measured every six hours. */
    static messagesGb: number = null;

    private sizedAt = 0;

    /** du over years of attachments takes a while, so it runs in the background, rarely. */
    private measureMessages() {
        if (Date.now() - this.sizedAt < 6 * 3600_000) return;
        this.sizedAt = Date.now();
        const dir = path.join(os.homedir(), "Library", "Messages");
        FileSystem.execShellCommand(`du -sk "${dir}"`)
            .then(out => {
                const kb = Number(String(out).trim().split(/\s+/)[0]);
                if (Number.isFinite(kb) && kb > 0) EchoGuard.messagesGb = Math.round((kb / 1048576) * 10) / 10;
            })
            .catch((): null => null);
    }

    /** Find My is left alone for a while after the server opens it to refresh locations. */
    static findMyBusyUntil = 0;

    static touchFindMy(ms = 3 * 60_000) {
        EchoGuard.findMyBusyUntil = Math.max(EchoGuard.findMyBusyUntil, Date.now() + ms);
    }

    private get enabled() {
        return (Server().repo?.getConfig("echo_guard") as boolean) ?? true;
    }

    private limit(key: string, fallback: number) {
        const v = Number(Server().repo?.getConfig(key));
        return Number.isFinite(v) && v > 0 ? v : fallback;
    }

    start() {
        if (this.timer) return;
        this.startedAt = Date.now();
        EchoGuard.loadEvents();
        this.log.info("Echo Guard is watching the server.");
        this.timer = setInterval(() => {
            this.tick().catch(ex => this.log.debug(`Check failed: ${ex?.message ?? String(ex)}`));
        }, 60_000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async tick() {
        if (!this.enabled || Server().isRestarting || Server().isStopping) return;

        const procs = await this.processes();
        this.measureMessages();

        // 1. The server's own memory, summed over every Electron process.
        const selfMb = app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024;
        if (this.strike("self", selfMb > this.limit("echo_server_limit_mb", 900), 3)) {
            return this.relaunch(`server memory stayed at ${Math.round(selfMb)} MB`);
        }

        EchoGuard.lastReading = {
            server: Math.round(selfMb),
            messages: Math.round(procs.get("Messages") ?? 0),
            findMy: Math.round(procs.get("FindMy") ?? 0),
            faceTime: Math.round(procs.get("FaceTime") ?? 0),
            freeDiskGb: this.freeDiskGb()
        };

        // 2. Messages. Killing it is enough: the Private API loop starts it again with the helper.
        const messagesMb = procs.get("Messages") ?? 0;
        if (this.strike("messages", messagesMb > this.limit("echo_messages_limit_mb", 1400), 3)) {
            if (!this.sending()) {
                this.note(`Restarting Messages (using ${Math.round(messagesMb)} MB)`);
                await FileSystem.execShellCommand(`killall Messages`).catch((): null => null);
                this.strikes.messages = 0;
            }
        }

        // 3. The API itself.
        const alive = await this.ping();
        if (this.strike("api", !alive, 3)) return this.relaunch("the API stopped answering");

        // 4. The Private API helper, which gives up after five quick crashes in a row.
        const papi = Server().repo.getConfig("enable_private_api") as boolean;
        const uptime = Date.now() - this.startedAt;
        const helperUp = !!Server().privateApi?.helper;
        if (helperUp) this.helperRepairs = 0;
        if (this.strike("helper", papi && uptime > 5 * 60_000 && !helperUp, 5)) {
            this.strikes.helper = 0;
            // First, reconnect just the helper: the server and its address stay put.
            if (this.helperRepairs < 2) {
                this.helperRepairs += 1;
                this.note(`Reconnecting the Private API helper (disconnected for five minutes, try ${this.helperRepairs} of 2)`);
                await Server().privateApi?.restart().catch((ex: any) => this.log.debug(`Helper restart failed: ${ex?.message ?? String(ex)}`));
                return;
            }
            // Still gone: a relaunch, but not in a loop.
            if (Date.now() - EchoGuard.helperRelaunchedAt > 2 * 3600_000 && !this.sending()) {
                this.helperRepairs = 0;
                return this.relaunch(HELPER_REASON);
            }
        }

        // 5. Apps that only cost memory when they sit in the background.
        const front = await this.frontmost();
        if (procs.has("FindMy") && front !== "FindMy" && Date.now() > EchoGuard.findMyBusyUntil) {
            this.note("Quitting Find My (left open in the background)");
            await FileSystem.execShellCommand(`osascript -e 'quit app "FindMy"'`).catch((): null => null);
        }
        const ft = Server().repo.getConfig("enable_ft_private_api") as boolean;
        if (!ft && procs.has("FaceTime") && front !== "FaceTime") {
            this.note("Quitting FaceTime (left open in the background)");
            await FileSystem.execShellCommand(`osascript -e 'quit app "FaceTime"'`).catch((): null => null);
        }

        // Reminders and Notes, when Echo opened them to answer the phone: quit once idle.
        for (const [name, lastUsed] of EchoMacApps.openedByEcho) {
            // In front means you're using it: it's yours now, and Echo leaves it alone.
            if (front === name) {
                EchoMacApps.openedByEcho.delete(name);
                continue;
            }
            if (Date.now() - lastUsed < 2 * 60_000) continue;
            EchoMacApps.openedByEcho.delete(name);
            await FileSystem.execShellCommand(`osascript -e 'quit app "${name}"'`).catch((): null => null);
            this.log.debug(`Quit ${name} (opened by Echo, now idle)`);
        }

        // 6. Disk space.
        const freeGb = EchoGuard.lastReading.freeDiskGb;
        if (freeGb !== null && freeGb < this.limit("echo_min_free_gb", 10)) {
            const cleared = this.clearCaches();
            if (cleared > 0) {
                const mb = Math.round(cleared / 1e6);
                this.note(`Disk low (${freeGb.toFixed(1)} GB free): cleared ${mb} MB of caches`);
            }
        }
    }

    /** Counts consecutive bad checks; true once there have been `needed` of them. */
    private strike(key: keyof EchoGuard["strikes"], bad: boolean, needed: number) {
        this.strikes[key] = bad ? this.strikes[key] + 1 : 0;
        return this.strikes[key] >= needed;
    }

    private sending() {
        const pending = (Server().messageManager?.promises ?? []).some(p => !p.isResolved);
        return pending;
    }

    private async relaunch(reason: string) {
        this.note(`Relaunching: ${reason}`);
        this.stop();
        await Server().relaunch();
    }

    /** Resident memory in MB for the apps we care about, by name. */
    private async processes(): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        const text = await FileSystem.execShellCommand(`ps -axo rss=,comm=`).catch((): string => "");
        for (const line of String(text).split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(.*)$/);
            if (!m) continue;
            const name = path.basename(m[2]);
            if (!["Messages", "FindMy", "FaceTime"].includes(name)) continue;
            if (!m[2].includes(`${name}.app/`)) continue;
            out.set(name, (out.get(name) ?? 0) + Number(m[1]) / 1024);
        }
        return out;
    }

    private async frontmost(): Promise<string> {
        // lsappinfo needs no extra permissions, unlike asking System Events.
        const out = await FileSystem.execShellCommand(`lsappinfo info -only name "$(lsappinfo front)"`).catch(
            (): string => ""
        );
        const m = String(out).match(/"LSDisplayName"="([^"]*)"/) ?? String(out).match(/=\s*"([^"]*)"/);
        return m?.[1] ?? "";
    }

    private ping(): Promise<boolean> {
        const port = Server().repo.getConfig("socket_port") as number;
        const password = encodeURIComponent(String(Server().repo.getConfig("password") ?? ""));
        const secure = !!Server().repo.getConfig("use_custom_certificate");
        const client = secure ? https : http;
        return new Promise(resolve => {
            const req = client.get(
                {
                    host: "127.0.0.1",
                    port,
                    path: `/api/v1/ping?password=${password}`,
                    timeout: 15_000,
                    rejectUnauthorized: false
                } as any,
                res => {
                    res.resume();
                    resolve((res.statusCode ?? 500) < 500);
                }
            );
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", () => resolve(false));
        });
    }

    freeDiskGb(): number | null {
        try {
            const st = (fs as any).statfsSync?.(os.homedir());
            if (!st) return null;
            return (Number(st.bavail) * Number(st.bsize)) / 1e9;
        } catch {
            return null;
        }
    }

    /** Empties the server's own re-creatable caches. Returns bytes freed. */
    private clearCaches(): number {
        let freed = 0;
        for (const dir of [FileSystem.attachmentCacheDir, FileSystem.convertDir]) {
            if (!fs.existsSync(dir)) continue;
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                try {
                    freed += EchoGuard.size(p);
                    (fs as any).rmSync(p, { recursive: true, force: true });
                } catch {
                    // In use; try again next time.
                }
            }
        }
        return freed;
    }

    private static size(p: string): number {
        const st = fs.lstatSync(p);
        if (!st.isDirectory()) return st.size;
        return fs.readdirSync(p).reduce((sum, n) => sum + EchoGuard.size(path.join(p, n)), 0);
    }
}
