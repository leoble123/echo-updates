import { execFile } from "child_process";
import { Loggable } from "@server/lib/logging/Loggable";
import * as S from "./scripts";

type AppName = "Reminders" | "Notes";

export type ReminderList = { id: string; name: string; color: string | null };
export type Reminder = {
    id: string;
    list: string;
    name: string;
    due: number | null;
    body: string;
    flagged: boolean;
    priority: number;
};
export type NoteSummary = {
    id: string;
    name: string;
    modified: number | null;
    locked: boolean;
    folder: string | null;
    snippet: string;
};

const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text as Notes stores it: one div per line, the first line as the title. */
export const textToNoteHtml = (text: string): string => {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    return lines
        .map((line, i) => {
            const body = escapeHtml(line) || "<br>";
            return i === 0 ? `<div><h1>${body}</h1></div>` : `<div>${body}</div>`;
        })
        .join("");
};

/**
 * Reminders and Notes on the Mac, driven by JavaScript for Automation. Calls to
 * one app run one at a time (Apple Events to the same app don't mix well), and
 * lists are cached briefly so the phone's screens open instantly. Apps opened
 * only to answer Echo are quit again by Echo Guard once they've sat idle.
 */
export class EchoMacApps extends Loggable {
    tag = "EchoMacApps";

    private static instance: EchoMacApps;

    static get() {
        EchoMacApps.instance ??= new EchoMacApps();
        return EchoMacApps.instance;
    }

    /** Apps Echo started (rather than you), with when it last used them. */
    static openedByEcho: Map<AppName, number> = new Map();

    private queues: Map<AppName, Promise<unknown>> = new Map();

    private cache: Map<string, { at: number; value: unknown }> = new Map();

    private isRunning(app: AppName): Promise<boolean> {
        return new Promise(resolve => {
            execFile("/usr/bin/pgrep", ["-x", app], err => resolve(!err));
        });
    }

    /** Runs [script] against [app], one at a time per app. */
    private run<T>(app: AppName, script: string, arg: unknown = {}): Promise<T> {
        const previous = this.queues.get(app) ?? Promise.resolve();
        const next = previous
            .catch((): null => null)
            .then(async () => {
                if (!(await this.isRunning(app)) && !EchoMacApps.openedByEcho.has(app)) {
                    EchoMacApps.openedByEcho.set(app, Date.now());
                }
                if (EchoMacApps.openedByEcho.has(app)) EchoMacApps.openedByEcho.set(app, Date.now());
                return new Promise<T>((resolve, reject) => {
                    execFile(
                        "/usr/bin/osascript",
                        ["-l", "JavaScript", "-e", script, JSON.stringify(arg)],
                        { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 },
                        (err, stdout, stderr) => {
                            if (err) {
                                const text = String(stderr ?? "");
                                // Never err.message: it repeats the whole command line, script and all.
                                if (/-1743|not authori[sz]ed/i.test(text)) {
                                    reject(new Error(
                                        `Echo Server isn't allowed to control ${app}. On the Mac, open System Settings → ` +
                                        `Privacy & Security → Automation → Echo Server, switch on ${app}.`
                                    ));
                                } else if ((err as any).killed || (err as any).signal) {
                                    reject(new Error(
                                        `${app} didn't answer in time. If your Mac is showing a prompt about ` +
                                        `Echo Server controlling ${app}, click Allow, then try again.`
                                    ));
                                } else {
                                    const last = text.trim().split("\n").pop()?.replace(/^.*execution error:\s*/, "");
                                    this.log.debug(`${app} script failed: ${text.trim().slice(0, 500)}`);
                                    reject(new Error(last || `${app} didn't answer`));
                                }
                                return;
                            }
                            try {
                                const value = JSON.parse(String(stdout).trim() || "null");
                                if (value == null) reject(new Error(`${app} answered with nothing - try again`));
                                else resolve(value);
                            } catch {
                                reject(new Error(`${app} sent something unexpected`));
                            }
                        }
                    );
                });
            });
        this.queues.set(app, next);
        return next;
    }

    private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
        const value = await load();
        this.cache.set(key, { at: Date.now(), value });
        return value;
    }

    private forget(prefix: string) {
        for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
    }

    // --- Reminders -----------------------------------------------------------------

    reminders(fresh = false) {
        if (fresh) this.forget("reminders");
        return this.cached("reminders", 15_000, () =>
            this.run<{ lists: ReminderList[]; reminders: Reminder[]; defaultList: string | null }>(
                "Reminders",
                S.REMINDERS_LIST
            )
        );
    }

    async addReminder(a: { name: string; list?: string; due?: number; body?: string }) {
        if (!a.name?.trim()) throw new Error("A reminder needs a title");
        const name = a.name.trim().slice(0, 500);
        const r = await this.run<{ id: string }>("Reminders", S.REMINDER_CREATE, { ...a, name });
        this.forget("reminders");
        return r;
    }

    async updateReminder(
        id: string,
        change: { completed?: boolean; name?: string; flagged?: boolean; due?: number | null }
    ) {
        await this.run("Reminders", S.REMINDER_UPDATE, { id, ...change });
        this.forget("reminders");
    }

    async deleteReminder(id: string) {
        await this.run("Reminders", S.REMINDER_DELETE, { id });
        this.forget("reminders");
    }

    // --- Notes --------------------------------------------------------------------

    notes(fresh = false) {
        if (fresh) this.forget("notes");
        return this.cached("notes", 30_000, () => this.run<NoteSummary[]>("Notes", S.NOTES_LIST, { limit: 100 }));
    }

    note(id: string) {
        return this.run<NoteSummary & { text: string; html: string; rich: boolean }>("Notes", S.NOTE_GET, { id });
    }

    async addNote(text: string) {
        if (!text.trim()) throw new Error("The note is empty");
        const r = await this.run<{ id: string }>("Notes", S.NOTE_CREATE, { html: textToNoteHtml(text) });
        this.forget("notes");
        return r;
    }

    /** Replaces a plain note's text. Rich notes (images, checklists, tables) are refused. */
    async updateNote(id: string, text: string) {
        const current = await this.note(id);
        if (current.locked) throw new Error("That note is locked");
        if (current.rich) throw new Error("That note has images or checklists - edit it on your Mac");
        await this.run("Notes", S.NOTE_UPDATE, { id, html: textToNoteHtml(text) });
        this.forget("notes");
    }
}
