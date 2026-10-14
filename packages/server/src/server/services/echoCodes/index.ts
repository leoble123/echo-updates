import { clipboard, Notification } from "electron";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";
import { EchoHandoff } from "@server/services/echoHandoff";

/** Socket event: a login code just arrived (the phone and Echo Web copy it too). */
export const CODE_EVENT = "echo-code";

const KEYWORD =
    /\b(code|codes|passcode|verification|verify|one[- ]?time|otp|pin|security|log ?in|sign[- ]?in|2fa|authenticat\w*|confirm\w*)\b|验证码|驗證碼|código|codigo|codice|kod|код|認証/i;
const KEYWORDS = new RegExp(KEYWORD.source, "gi");
// 4-8 digits, optionally split 3-3 or 4-4, optionally after a prefix like Google's "G-".
const CANDIDATE = /(?<![\w$€£#.,/:@-])(?<!\d[ -])(?:[A-Z]{1,3}-)?(\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\w%$€£@]|[.,/:]\d|[ -]\d)/g;

/**
 * The login code in a message - "Your Uber code is 4821" - or null. The same
 * narrow rules as the phone's: a number only counts beside a word about codes,
 * and years and times of day are left alone.
 */
export const findCode = (text: string): string | null => {
    if (!text || text.length > 600 || !KEYWORD.test(text)) return null;
    const words = [...text.matchAll(KEYWORDS)].map(m => m.index ?? 0);
    let best: { code: string; d: number } | null = null;
    for (const m of text.matchAll(CANDIDATE)) {
        const at = m.index ?? 0;
        const digits = m[1].replace(/\D/g, "");
        if (digits.length === 4 && m[0].length === 4 && +digits >= 1900 && +digits <= 2099) {
            const before = text.slice(0, at).trimEnd().toLowerCase();
            if (!before.endsWith(":") && !before.endsWith("is") && !before.endsWith("code")) continue;
        }
        if (/^\s*(am|pm)\b/i.test(text.slice(at + m[0].length))) continue;
        // 555-1234 is a phone number; split codes are 3-3 or 4-4.
        if (/^\d{3}-\d{4}$/.test(m[1])) continue;
        const d = Math.min(...words.map(w => Math.abs(w - at)));
        if (!best || d < best.d) best = { code: digits, d };
    }
    return best?.code ?? null;
};

/**
 * Codes copy themselves: a fresh one lands on the Mac's clipboard, and a
 * notification says so. Turned off with echo_auto_codes.
 */
export class EchoCodes extends Loggable {
    tag = "EchoCodes";

    private static instance: EchoCodes;

    static get() {
        EchoCodes.instance ??= new EchoCodes();
        return EchoCodes.instance;
    }

    private lastGuid: string = null;

    get enabled() {
        const v = Server().repo.getConfig("echo_auto_codes");
        return !(v === false || v === 0 || v === "0" || v === "false");
    }

    onMessage(message: any) {
        try {
            if (!this.enabled || !message || message.isFromMe || typeof message.text !== "string") return;
            if (message.guid && message.guid === this.lastGuid) return;
            // Only now-ish: a catch-up after a restart mustn't bury the clipboard in old codes.
            const at = Number(message.dateCreated) || Date.now();
            if (Date.now() - at > 5 * 60_000) return;
            const code = findCode(message.text);
            if (!code) return;
            this.lastGuid = message.guid;
            clipboard.writeText(code);
            EchoHandoff.get().noteCopied(code);
            const chat = message.chats?.[0]?.guid ?? null;
            const from = message.handle?.address ?? null;
            Server().emitMessage(CODE_EVENT, { code, chat, from, guid: message.guid, at }, "normal", false);
            // With Universal Clipboard on, everything else following the clipboard gets it too.
            if (EchoHandoff.get().clipboardOn) EchoHandoff.get().announceClip({ text: code, at: Date.now(), from: "code" });
            if (Notification.isSupported()) {
                new Notification({ title: `Code ${code} copied`, body: message.text.slice(0, 120), silent: true }).show();
            }
        } catch (ex: any) {
            this.log.debug(`Code check failed: ${ex?.message ?? String(ex)}`);
        }
    }
}
