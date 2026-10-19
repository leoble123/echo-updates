/**
 * Echo Guard's decisions about the Private API helper, without the server
 * around them, so they can be tested on their own (test/echoGuard.test.ts).
 */

/** At most one relaunch over the helper in this long. */
export const HELPER_RELAUNCH_GAP_MS = 2 * 3600_000;

/** Helper reconnects tried before a relaunch is considered. */
export const HELPER_REPAIRS = 2;

export type HelperStep = "repair" | "relaunch" | "wait";

/**
 * What to do once the helper has been gone long enough to act: reconnect just
 * the helper (twice), then relaunch the server - unless that happened in the
 * last two hours or a message is on its way out.
 */
export function helperStep(repairsSoFar: number, lastRelaunchAt: number, now: number, sending: boolean): HelperStep {
    if (repairsSoFar < HELPER_REPAIRS) return "repair";
    if (now - lastRelaunchAt > HELPER_RELAUNCH_GAP_MS && !sending) return "relaunch";
    return "wait";
}

/** When the server was last relaunched over the helper, from Guard's saved history. */
export function lastRelaunch(events: { at: number; text: string }[], marker: string): number {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].text.startsWith(marker)) return events[i].at;
    }
    return 0;
}
