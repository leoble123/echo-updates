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

    static heard(guid: string, display: boolean) {
        EchoTyping.heardCount++;
        EchoTyping.lastHeard = { at: Date.now(), guid, display };
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
}
