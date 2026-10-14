import { Server } from "@server";
import { TYPING_INDICATOR } from "@server/events";

/**
 * What's happened with typing indicators, for the phone's Your Mac screen:
 * whether Messages is reporting other people typing at all, and whether
 * yours are going out. Typing rides entirely on the Private API helper, so
 * when it's quiet this is how to tell which side is.
 */
export class EchoTyping {
    static heardCount = 0;

    static lastHeard: { at: number; guid: string; display: boolean } = null;

    static sentCount = 0;

    static lastSent: { at: number; guid: string; display: boolean } = null;

    /** Who's typing right now, by chat guid, until when - for devices without the live feed. */
    static active = new Map<string, number>();

    static heard(guid: string, display: boolean) {
        EchoTyping.heardCount++;
        EchoTyping.lastHeard = { at: Date.now(), guid, display };
        EchoTyping.mark(guid, display);
    }

    static mark(guid: string, display: boolean) {
        if (display) EchoTyping.active.set(guid, Date.now() + 30_000);
        else EchoTyping.active.delete(guid);
    }

    /** A message from them landed: they've stopped typing, whatever the helper says. */
    static landed(guid: string) {
        if (!EchoTyping.active.delete(guid)) return;
        Server().emitMessage(TYPING_INDICATOR, { display: false, guid }, "normal", false);
    }

    /** Chats with someone typing now. Cheap enough to ask every couple of seconds. */
    static now(): { typing: string[]; heard: number } {
        const t = Date.now();
        for (const [guid, until] of EchoTyping.active) if (until < t) EchoTyping.active.delete(guid);
        return { typing: [...EchoTyping.active.keys()], heard: EchoTyping.heardCount };
    }

    static sent(guid: string, display: boolean) {
        EchoTyping.sentCount++;
        EchoTyping.lastSent = { at: Date.now(), guid, display };
    }

    static summary() {
        return {
            heard: EchoTyping.heardCount,
            lastHeardAt: EchoTyping.lastHeard?.at ?? null,
            sent: EchoTyping.sentCount,
            lastSentAt: EchoTyping.lastSent?.at ?? null
        };
    }

    /**
     * A pretend "typing…" in your most recent conversation, sent to your
     * devices exactly as a real one would be, then cleared. Tests everything
     * from here to the phone without needing someone to type.
     */
    static async test(): Promise<{ chat: string }> {
        const [messages] = await Server().iMessageRepo.getMessages({ limit: 1, sort: "DESC", withChats: true, withAttachments: false });
        const chat = messages[0]?.chats?.[0];
        if (!chat?.guid) throw new Error("No conversations to test with yet");
        EchoTyping.mark(chat.guid, true);
        Server().emitMessage(TYPING_INDICATOR, { display: true, guid: chat.guid }, "normal", false);
        setTimeout(() => {
            EchoTyping.mark(chat.guid, false);
            Server().emitMessage(TYPING_INDICATOR, { display: false, guid: chat.guid }, "normal", false);
        }, 8000);
        return { chat: chat.displayName || chat.chatIdentifier || chat.guid };
    }
}
