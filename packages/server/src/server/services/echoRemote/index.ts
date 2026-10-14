import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { Loggable } from "@server/lib/logging/Loggable";

const exec = (cmd: string, args: string[], timeout = 15_000): Promise<string> =>
    new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim().split("\n").pop() || "Failed"));
            else resolve(String(stdout).trim());
        });
    });

const osa = (script: string) => exec("/usr/bin/osascript", ["-e", script]);

export type MacState = {
    locked: boolean | null;
    idleSec: number | null;
    uptimeSec: number;
    volume: number | null;
    muted: boolean | null;
    nowPlaying: { app: string; state: string; title: string; artist: string } | null;
};

/** Your Mac from your phone: whether it's in use, its sound and music, a look at its screen. */
export class EchoRemote extends Loggable {
    tag = "EchoRemote";

    private static instance: EchoRemote;

    static get() {
        EchoRemote.instance ??= new EchoRemote();
        return EchoRemote.instance;
    }

    private async running(app: string) {
        try {
            await exec("/usr/bin/pgrep", ["-x", app]);
            return true;
        } catch {
            return false;
        }
    }

    /** The music app to talk to: whichever is playing, else whichever is open (Spotify first). */
    private async player(): Promise<string | null> {
        const open: string[] = [];
        for (const app of ["Spotify", "Music"]) if (await this.running(app)) open.push(app);
        for (const app of open) {
            try {
                if ((await osa(`tell application "${app}" to player state as string`)) === "playing") return app;
            } catch {
                /* not answering */
            }
        }
        return open[0] ?? null;
    }

    async state(): Promise<MacState> {
        const out: MacState = { locked: null, idleSec: null, uptimeSec: Math.round(os.uptime()), volume: null, muted: null, nowPlaying: null };
        try {
            const reg = await exec("/usr/sbin/ioreg", ["-n", "Root", "-d1"]);
            out.locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(reg);
        } catch {
            /* unknown */
        }
        try {
            const hid = await exec("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
            const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid);
            if (m) out.idleSec = Math.round(Number(m[1]) / 1e9);
        } catch {
            /* unknown */
        }
        try {
            const [vol, muted] = (await osa("set s to get volume settings\nreturn (output volume of s as string) & \",\" & (output muted of s as string)")).split(",");
            out.volume = Number(vol);
            out.muted = muted === "true";
        } catch {
            /* no output device */
        }
        const app = await this.player();
        if (app) {
            try {
                const r = await osa(
                    `tell application "${app}"\n` +
                        "set st to player state as string\n" +
                        "if st is \"stopped\" then return st & \"\\n\\n\"\n" +
                        "return st & \"\\n\" & (name of current track) & \"\\n\" & (artist of current track)\n" +
                        "end tell"
                );
                const [st, title, artist] = r.split("\n");
                out.nowPlaying = { app, state: st, title: title ?? "", artist: artist ?? "" };
            } catch {
                /* not allowed or nothing loaded */
            }
        }
        return out;
    }

    /** Turns the display off; with "require password" on (the default) that locks the Mac too. */
    async lock() {
        await exec("/usr/bin/pmset", ["displaysleepnow"]);
    }

    async setVolume(v: number) {
        const n = Math.max(0, Math.min(100, Math.round(v)));
        await osa(`set volume output volume ${n} without output muted`);
    }

    async mute(on: boolean) {
        await osa(`set volume ${on ? "with" : "without"} output muted`);
    }

    async media(action: "playpause" | "next" | "previous") {
        const app = await this.player();
        if (!app) throw new Error("Nothing's playing - open Music or Spotify on the Mac");
        const verb = { playpause: "playpause", next: "next track", previous: "previous track" }[action];
        if (!verb) throw new Error("Unknown action");
        await osa(`tell application "${app}" to ${verb}`);
    }

    /** Opens a link on the Mac, in its default browser. */
    async open(url: string) {
        if (!/^https?:\/\//i.test(url)) throw new Error("Only web links can be opened");
        await exec("/usr/bin/open", [url]);
    }

    /** Says something out loud on the Mac. */
    async say(text: string) {
        const t = String(text ?? "").trim().slice(0, 500);
        if (!t) throw new Error("Nothing to say");
        await exec("/usr/bin/say", [t], 60_000);
    }

    /** A JPEG of the screen, at most 1600 px across. Needs Screen Recording permission for Echo Server. */
    async screenshot(): Promise<string> {
        const file = path.join(os.tmpdir(), `echo-screen-${Date.now()}.jpg`);
        await exec("/usr/sbin/screencapture", ["-x", "-t", "jpg", file]);
        if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
            throw new Error("macOS didn't allow a screenshot - turn on Echo Server under System Settings → Privacy & Security → Screen Recording");
        }
        await exec("/usr/bin/sips", ["-Z", "1600", file]).catch((): null => null);
        return file;
    }
}
