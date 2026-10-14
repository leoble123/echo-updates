import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";
import { MessageInterface } from "@server/api/interfaces/messageInterface";

export type Scheduled = {
    id: string;
    chatGuid: string;
    text: string;
    /** When to send, epoch ms. */
    at: number;
    createdAt: number;
    status: "pending" | "sent" | "failed";
    tries: number;
    error?: string;
    sentAt?: number;
};

/** Socket event: a scheduled message was sent or gave up. */
export const SCHEDULED_EVENT = "echo-scheduled";

/**
 * Messages to send later. They live on the Mac and the Mac sends them, so
 * they go out on time even if the phone is off, asleep or dead.
 */
export class EchoSchedule extends Loggable {
    tag = "EchoSchedule";

    private static instance: EchoSchedule;

    static get() {
        EchoSchedule.instance ??= new EchoSchedule();
        return EchoSchedule.instance;
    }

    static file = path.join(os.homedir(), "Library", "Application Support", "Echo", "scheduled.json");

    private items: Scheduled[] = [];

    private timer: NodeJS.Timeout = null;

    private busy = false;

    start() {
        if (this.timer) return;
        try {
            this.items = JSON.parse(fs.readFileSync(EchoSchedule.file, "utf8"));
            if (!Array.isArray(this.items)) this.items = [];
        } catch {
            this.items = [];
        }
        this.timer = setInterval(() => this.tick(), 15_000);
    }

    private save() {
        try {
            fs.mkdirSync(path.dirname(EchoSchedule.file), { recursive: true });
            const tmp = EchoSchedule.file + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
            fs.renameSync(tmp, EchoSchedule.file);
        } catch (ex: any) {
            this.log.debug(`Couldn't save scheduled messages: ${ex?.message}`);
        }
    }

    list(chatGuid?: string): Scheduled[] {
        // Sent ones are kept a day so devices see them go out, then forgotten.
        const cutoff = Date.now() - 24 * 3600_000;
        return this.items
            .filter(i => i.status !== "sent" || (i.sentAt ?? 0) > cutoff)
            .filter(i => !chatGuid || i.chatGuid === chatGuid)
            .sort((a, b) => a.at - b.at);
    }

    add(chatGuid: string, text: string, at: number): Scheduled {
        if (!chatGuid) throw new Error("Which conversation?");
        const clean = String(text ?? "").trim();
        if (!clean) throw new Error("The message is empty");
        if (!Number.isFinite(at) || at < Date.now() - 60_000) throw new Error("That time has already passed");
        if (at > Date.now() + 366 * 24 * 3600_000) throw new Error("That's more than a year away");
        if (this.items.filter(i => i.status === "pending").length >= 200) throw new Error("Too many scheduled messages");
        const item: Scheduled = {
            id: crypto.randomBytes(12).toString("hex"),
            chatGuid,
            text: clean.slice(0, 10_000),
            at: Math.round(at),
            createdAt: Date.now(),
            status: "pending",
            tries: 0
        };
        this.items.push(item);
        this.save();
        return item;
    }

    update(id: string, change: { text?: string; at?: number }): Scheduled {
        const item = this.items.find(i => i.id === id && i.status === "pending");
        if (!item) throw new Error("That message has already gone or was cancelled");
        if (change.text !== undefined) {
            const t = String(change.text).trim();
            if (!t) throw new Error("The message is empty");
            item.text = t.slice(0, 10_000);
        }
        if (change.at !== undefined) {
            if (!Number.isFinite(change.at) || change.at < Date.now() - 60_000) throw new Error("That time has already passed");
            item.at = Math.round(change.at);
        }
        this.save();
        return item;
    }

    cancel(id: string) {
        const before = this.items.length;
        this.items = this.items.filter(i => !(i.id === id && i.status !== "sent"));
        if (this.items.length === before) throw new Error("That message has already gone");
        this.save();
    }

    private async tick() {
        if (this.busy) return;
        // A purge of old history, so the file doesn't grow forever.
        const cutoff = Date.now() - 7 * 24 * 3600_000;
        const keep = this.items.filter(i => i.status === "pending" || (i.sentAt ?? i.at) > cutoff);
        if (keep.length !== this.items.length) {
            this.items = keep;
            this.save();
        }
        const due = this.items.filter(i => i.status === "pending" && i.at <= Date.now());
        if (!due.length) return;
        this.busy = true;
        try {
            for (const item of due) await this.send(item);
        } finally {
            this.busy = false;
        }
    }

    private async send(item: Scheduled) {
        item.tries++;
        try {
            await MessageInterface.sendMessageSync({
                chatGuid: item.chatGuid,
                message: item.text,
                method: Server().privateApi?.helper ? "private-api" : "apple-script",
                tempGuid: `echo-scheduled-${item.id}`
            });
            item.status = "sent";
            item.sentAt = Date.now();
            this.log.info(`Sent a scheduled message to ${item.chatGuid}`);
        } catch (ex: any) {
            item.error = String(ex?.message ?? ex).slice(0, 300);
            // Three goes, a minute or so apart, before giving up and saying so.
            if (item.tries >= 3) item.status = "failed";
            else item.at = Date.now() + 60_000;
            this.log.debug(`Scheduled message failed (try ${item.tries}): ${item.error}`);
        }
        this.save();
        if (item.status !== "pending") {
            Server().emitMessage(SCHEDULED_EVENT, item, "normal", false);
        }
    }
}
