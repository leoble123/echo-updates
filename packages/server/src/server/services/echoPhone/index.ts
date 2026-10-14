import { Notification } from "electron";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";

/** Socket events: the phone's latest state, a notification on it, one gone, and "ring!". */
export const PHONE_STATE_EVENT = "echo-phone-state";
export const PHONE_NOTIFICATION_EVENT = "echo-phone-notification";
export const PHONE_NOTIFICATION_GONE_EVENT = "echo-phone-notification-removed";
export const PHONE_RING_EVENT = "echo-phone-ring";

export type PhoneState = {
    battery: number | null;
    charging: boolean;
    /** 0-4 bars, null without a SIM or signal. */
    signal: number | null;
    /** "wifi", "cellular", "none". */
    network: string;
    carrier: string | null;
    hotspot: boolean | null;
    name: string | null;
    at: number;
};

export type PhoneNotification = { id: string; app: string; appName: string; title: string; text: string; at: number };

const KEEP = 50;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/**
 * The phone, as the computers see it: battery, signal and hotspot; the
 * notifications on it; and Find My Phone's ring. The phone reports in, the Mac
 * keeps the latest in memory (nothing is written to disk) and passes it to
 * every connected device.
 */
export class EchoPhone extends Loggable {
    tag = "EchoPhone";

    private static instance: EchoPhone;

    static get() {
        EchoPhone.instance ??= new EchoPhone();
        return EchoPhone.instance;
    }

    state: PhoneState = null;

    notifications: PhoneNotification[] = [];

    private announce(event: string, data: unknown) {
        Server().emitMessage(event, data, "normal", false);
    }

    get macNotifications() {
        const v = Server().repo.getConfig("echo_phone_notifications_mac");
        return v === true || v === 1 || v === "1" || v === "true";
    }

    report(b: any): PhoneState {
        const num = (v: unknown, lo: number, hi: number) =>
            typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null;
        this.state = {
            battery: num(b.battery, 0, 100),
            charging: b.charging === true,
            signal: num(b.signal, 0, 4),
            network: ["wifi", "cellular", "none"].includes(b.network) ? b.network : "none",
            carrier: clip(b.carrier, 60) || null,
            hotspot: typeof b.hotspot === "boolean" ? b.hotspot : null,
            name: clip(b.name, 60) || null,
            at: Date.now()
        };
        this.announce(PHONE_STATE_EVENT, this.state);
        return this.state;
    }

    notify(b: any): PhoneNotification {
        const n: PhoneNotification = {
            id: clip(b.id, 200),
            app: clip(b.app, 200),
            appName: clip(b.appName, 80) || clip(b.app, 80),
            title: clip(b.title, 200),
            text: clip(b.text, 1000),
            at: Number(b.at) || Date.now()
        };
        if (!n.id) throw new Error("id is required");
        // An update replaces the old one, newest first.
        this.notifications = [n, ...this.notifications.filter(x => x.id !== n.id)].slice(0, KEEP);
        this.announce(PHONE_NOTIFICATION_EVENT, n);
        if (this.macNotifications && Notification.isSupported()) {
            try {
                new Notification({ title: n.title || n.appName, subtitle: n.appName, body: n.text, silent: true }).show();
            } catch {
                /* a nicety */
            }
        }
        return n;
    }

    /** Gone from the phone (dismissed, or opened) - or dismissed on a computer, which tells the phone. */
    remove(id: string) {
        const before = this.notifications.length;
        this.notifications = this.notifications.filter(x => x.id !== id);
        if (this.notifications.length !== before) this.announce(PHONE_NOTIFICATION_GONE_EVENT, { id });
    }

    clearAll() {
        for (const n of this.notifications) this.announce(PHONE_NOTIFICATION_GONE_EVENT, { id: n.id });
        this.notifications = [];
    }

    /** Find My Phone: every connected phone starts ringing, even on silent. */
    ring(stop = false, from = "computer") {
        this.announce(PHONE_RING_EVENT, { stop, from, at: Date.now() });
        return { ringing: !stop };
    }
}
