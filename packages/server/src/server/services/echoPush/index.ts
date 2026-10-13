import fs from "fs";
import path from "path";
import webpush from "web-push";
import { FileSystem } from "@server/fileSystem";
import { Loggable } from "@server/lib/logging/Loggable";

type Subscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    name?: string;
    addedAt?: number;
    /** Chats this browser has muted: no push for them. */
    muted?: string[];
};

/** Chat guids differ in their service prefix across macOS versions (any;-; vs iMessage;-;). */
const chatKey = (guid: string) => (guid ?? "").slice((guid ?? "").indexOf(";") + 1);

type Store = {
    vapid: { publicKey: string; privateKey: string };
    subs: Subscription[];
};

/**
 * Web Push for Echo Web: new messages reach a browser (or the Echo app on a PC)
 * even when no Echo window is open. The payload is encrypted end to end
 * (RFC 8291), so the browser's push service only relays ciphertext.
 */
export class EchoPush extends Loggable {
    tag = "EchoPush";

    private static instance: EchoPush;

    static get() {
        EchoPush.instance ??= new EchoPush();
        return EchoPush.instance;
    }

    private store: Store = null;

    private get file() {
        return path.join(FileSystem.baseDir, "echo", "push.json");
    }

    private load(): Store {
        if (this.store) return this.store;
        try {
            this.store = JSON.parse(fs.readFileSync(this.file, "utf8"));
        } catch {
            this.store = null;
        }
        if (!this.store?.vapid?.publicKey) {
            this.store = { vapid: webpush.generateVAPIDKeys(), subs: [] };
            this.save();
            this.log.info("Created this server's Web Push keys");
        }
        this.store.subs ??= [];
        return this.store;
    }

    private save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.store), { mode: 0o600 });
    }

    publicKey(): string {
        return this.load().vapid.publicKey;
    }

    subscribe(sub: Subscription, name?: string, muted?: string[]) {
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("Not a push subscription");
        if (!/^https:\/\//.test(sub.endpoint)) throw new Error("Push endpoints must be https");
        const store = this.load();
        store.subs = store.subs.filter(s => s.endpoint !== sub.endpoint);
        store.subs.push({
            endpoint: sub.endpoint,
            keys: sub.keys,
            name: name?.slice(0, 80),
            addedAt: Date.now(),
            muted: Array.isArray(muted) ? muted.filter(g => typeof g === "string").slice(0, 500).map(chatKey) : []
        });
        // A browser that has been reinstalled many times shouldn't grow this for ever.
        store.subs = store.subs.slice(-20);
        this.save();
    }

    unsubscribe(endpoint: string) {
        const store = this.load();
        const before = store.subs.length;
        store.subs = store.subs.filter(s => s.endpoint !== endpoint);
        if (store.subs.length !== before) this.save();
    }

    get count() {
        return this.load().subs.length;
    }

    /** Called for every new message; only incoming ones are pushed. */
    async onMessage(message: any) {
        try {
            if (!message || message.isFromMe) return;
            // Taking a tapback away isn't news.
            const assoc = Number(message.associatedMessageType) || 0;
            if (assoc >= 3000 && assoc < 4000) return;
            const store = this.load();
            if (store.subs.length === 0) return;
            const chat = message.chats?.[0] ?? {};
            const key = chatKey(chat.guid);
            // Kept small: push services cap payloads at 4 KB. The browser fills in names
            // and photos from its own cache.
            const payload = JSON.stringify({
                type: "message",
                guid: message.guid,
                chat: chat.guid ?? null,
                chatName: chat.displayName || null,
                group: (chat.style ?? 0) === 43 || (chat.participants?.length ?? 0) > 1,
                from: message.handle?.address ?? null,
                text: typeof message.text === "string" ? message.text.slice(0, 400) : null,
                subject: message.subject || null,
                attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
                tapback: message.associatedMessageType || null,
                at: message.dateCreated ?? Date.now()
            });
            await this.send(payload, sub => !(sub.muted ?? []).includes(key));
        } catch (ex: any) {
            this.log.debug(`Push failed: ${ex?.message ?? String(ex)}`);
        }
    }

    async send(payload: string, wanted: (sub: Subscription) => boolean = () => true) {
        const store = this.load();
        const options = {
            vapidDetails: {
                subject: "https://leoble123.github.io/echo-updates/web/",
                publicKey: store.vapid.publicKey,
                privateKey: store.vapid.privateKey
            },
            TTL: 6 * 3600,
            urgency: "high" as const,
            timeout: 15_000
        };
        const gone: string[] = [];
        await Promise.all(
            store.subs.filter(wanted).map(async sub => {
                try {
                    await webpush.sendNotification(sub, payload, options);
                } catch (ex: any) {
                    // 404 / 410: the browser dropped this subscription.
                    if (ex?.statusCode === 404 || ex?.statusCode === 410) gone.push(sub.endpoint);
                    else this.log.debug(`Push to ${sub.name ?? "a browser"} failed: ${ex?.statusCode ?? ex?.message}`);
                }
            })
        );
        if (gone.length) {
            store.subs = store.subs.filter(s => !gone.includes(s.endpoint));
            this.save();
            this.log.info(`Removed ${gone.length} expired push subscription(s)`);
        }
    }
}
