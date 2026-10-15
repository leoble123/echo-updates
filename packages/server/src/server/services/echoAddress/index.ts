import fs from "fs";
import https from "https";
import os from "os";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { Loggable } from "@server/lib/logging/Loggable";
import { EchoGuard } from "@server/services/echoGuard";

/**
 * Keeps the Mac reachable, and tells devices every way to reach it.
 *
 * The permanent address (Tailscale Funnel) can vanish without the Mac noticing:
 * a Tailscale or macOS update resets Funnel and the public name stops resolving,
 * while from inside the tailnet the same name still answers - so a check run on
 * the Mac itself always passed. This one asks public DNS, the way a phone out of
 * the house sees it, and turns Funnel back on when the name is gone.
 *
 * It also lists the other routes in (the Tailscale address, home Wi-Fi) for
 * /echo/status, so a phone can fall back to one when the public address dies.
 */
export class EchoAddress extends Loggable {
    tag = "EchoAddress";

    private static instance: EchoAddress;

    static get(): EchoAddress {
        if (!EchoAddress.instance) EchoAddress.instance = new EchoAddress();
        return EchoAddress.instance;
    }

    private timer: NodeJS.Timeout = null;

    private failures = 0;

    /** The last outside check, for the status screens. */
    status: { at: number; ok: boolean; detail: string } = null;

    /** Where the Tailscale command line is, if Tailscale is installed. */
    tailscale(): string {
        const candidates = [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale"
        ];
        return candidates.find(p => fs.existsSync(p)) ?? null;
    }

    port(): number {
        return Number(Server().repo.getConfig("socket_port")) || 1234;
    }

    /** The permanent address, when it's a Tailscale Funnel one. */
    funnelHost(): string {
        const address = String(Server().repo.getConfig("server_address") ?? "");
        const host = address.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
        return host.endsWith(".ts.net") ? host : null;
    }

    /** This Mac's Tailscale address (100.64.0.0/10), from its own network interfaces. */
    tailnetIp(): string {
        for (const list of Object.values(os.networkInterfaces())) {
            for (const a of list ?? []) {
                if (a.family !== "IPv4" || a.internal) continue;
                const [x, y] = a.address.split(".").map(Number);
                if (x === 100 && y >= 64 && y <= 127) return a.address;
            }
        }
        return null;
    }

    /** Every way in, best first: the permanent address, then Tailscale, then home Wi-Fi. */
    routes() {
        const port = this.port();
        const out: { kind: string; url: string }[] = [];
        const address = String(Server().repo.getConfig("server_address") ?? "");
        if (address) out.push({ kind: "public", url: address });
        const ts = this.tailnetIp();
        if (ts) out.push({ kind: "tailscale", url: `http://${ts}:${port}` });
        for (const list of Object.values(os.networkInterfaces())) {
            for (const a of list ?? []) {
                if (a.family !== "IPv4" || a.internal) continue;
                if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ kind: "home", url: `http://${a.address}:${port}` });
            }
        }
        return out;
    }

    start() {
        this.stop();
        // First look a couple of minutes in (Tailscale may still be connecting), then every five.
        this.timer = setTimeout(() => this.tick(), 2 * 60_000);
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private async tick() {
        try {
            await this.check();
        } catch (e: any) {
            this.log.debug(`address check failed: ${e?.message ?? e}`);
        }
        this.timer = setTimeout(() => this.tick(), 5 * 60_000);
    }

    /** Does the public internet know this name? Asked of Google's public DNS, not the Mac's own. */
    private publicDns(host: string): Promise<boolean> {
        return new Promise(resolve => {
            const req = https.get(
                `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
                { timeout: 10_000 },
                res => {
                    let body = "";
                    res.on("data", c => (body += c));
                    res.on("end", () => {
                        try {
                            const j = JSON.parse(body);
                            resolve(j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0);
                        } catch {
                            resolve(true); // Can't tell - don't act on it.
                        }
                    });
                }
            );
            req.on("timeout", () => req.destroy());
            req.on("error", () => resolve(true)); // No internet here is a different problem.
        });
    }

    async check(): Promise<{ ok: boolean; detail: string }> {
        const host = this.funnelHost();
        if (!host) {
            this.status = { at: Date.now(), ok: true, detail: "No Tailscale address to watch" };
            return this.status;
        }
        const ok = await this.publicDns(host);
        if (ok) {
            this.failures = 0;
            this.status = { at: Date.now(), ok: true, detail: "Reachable from outside" };
            return this.status;
        }
        this.failures++;
        this.status = { at: Date.now(), ok: false, detail: "The public address isn't published" };
        // Twice in a row (ten minutes), so a blip in Tailscale's DNS isn't mistaken for it.
        if (this.failures >= 2) {
            const fixed = await this.repairFunnel();
            this.failures = 0;
            this.status = { at: Date.now(), ok: fixed, detail: fixed ? "Turned the public address back on" : "Couldn't turn it back on" };
        }
        return this.status;
    }

    /** `tailscale funnel --bg <port>`: what the Permanent Address script set up. */
    async repairFunnel(): Promise<boolean> {
        const ts = this.tailscale();
        if (!ts) return false;
        const out = await FileSystem.execShellCommand(`"${ts}" funnel --bg ${this.port()} 2>&1`).catch((e: any) => `failed: ${e?.message ?? e}`);
        const ok = !/fail|error|not allowed|login/i.test(String(out));
        EchoGuard.record(ok ? "Turned the permanent address (Tailscale Funnel) back on" : `Couldn't turn the permanent address back on: ${String(out).slice(0, 160)}`);
        return ok;
    }

    /**
     * Fix My Mac: what the phone's button asks for. Each part reports what it did.
     *  - address: Funnel back on
     *  - messages: quit Messages (the Private API loop reopens it with the helper)
     *  - engine: relaunch Echo Server (answered first, then it goes)
     */
    async repair(what: string): Promise<{ done: string[] }> {
        const done: string[] = [];
        if (what === "address" || what === "all") {
            const ok = await this.repairFunnel();
            done.push(ok ? "Public address: back on" : this.tailscale() ? "Public address: Tailscale refused (open Tailscale on the Mac)" : "Public address: Tailscale isn't installed");
        }
        if (what === "messages" || what === "all") {
            await FileSystem.execShellCommand(`killall Messages`).catch((): null => null);
            done.push("Messages: restarted");
            EchoGuard.record("Restarted Messages (Fix My Mac)");
        }
        if (what === "engine" || what === "all") {
            done.push("Echo Server: restarting - back in about 30 seconds");
            EchoGuard.record("Restarting Echo Server (Fix My Mac)");
            setTimeout(() => Server().relaunch(), 1500);
        }
        return { done };
    }
}
