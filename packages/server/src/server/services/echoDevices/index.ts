import { Server } from "@server";

export const PRESENCE_EVENT = "echo-presence";
export const SEEN_EVENT = "echo-seen";

/** One of your Echo devices, as it last told us. */
export type EchoDevice = {
    id: string;
    name: string;
    /** "phone" or "tablet". */
    kind: string;
    /** On screen right now. */
    foreground: boolean;
    /** When it was last being used. */
    activeAt: number;
    /** When it last checked in at all. */
    seenAt: number;
};

/**
 * Your phones and tablets, so they can share the work of alerting you: the
 * one you're using rings, the others stay quiet, and reading or swiping
 * away an alert on one clears it on the rest - read receipts or not. Kept
 * in memory; devices check in again within minutes of a restart.
 */
export class EchoDevices {
    static devices = new Map<string, EchoDevice>();

    static report(b: any): EchoDevice[] {
        const id = String(b?.id ?? "").slice(0, 64);
        if (!id) return EchoDevices.list();
        const now = Date.now();
        const old = EchoDevices.devices.get(id);
        const foreground = b?.foreground === true;
        const reportedActive = Number(b?.activeAt) || 0;
        EchoDevices.devices.set(id, {
            id,
            name: String(b?.name ?? "Android").slice(0, 60),
            kind: b?.kind === "tablet" ? "tablet" : "phone",
            foreground,
            // Clocks differ between devices: the Mac's own clock decides.
            activeAt: foreground ? now : Math.max(old?.activeAt ?? 0, Math.min(reportedActive, now)),
            seenAt: now
        });
        const list = EchoDevices.list();
        // Only worth telling everyone when who's in front changed.
        if (!old || old.foreground !== foreground) {
            Server().emitMessage(PRESENCE_EVENT, { devices: list }, "normal", false);
        }
        return list;
    }

    static list(): EchoDevice[] {
        const cutoff = Date.now() - 30 * 24 * 3600_000;
        for (const [id, d] of EchoDevices.devices) if (d.seenAt < cutoff) EchoDevices.devices.delete(id);
        return [...EchoDevices.devices.values()];
    }

    /** Read (or swiped away) on one device: tell the others. */
    static seen(b: any): { ok: boolean } {
        const chatGuid = String(b?.chatGuid ?? "");
        if (!chatGuid) return { ok: false };
        Server().emitMessage(
            SEEN_EVENT,
            {
                chatGuid,
                upTo: Number(b?.upTo) || Date.now(),
                dismissed: b?.dismissed === true,
                from: String(b?.from ?? "").slice(0, 64)
            },
            "normal",
            false
        );
        return { ok: true };
    }
}
