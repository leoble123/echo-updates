import { EchoSearch } from "@server/services/echoSearch";

/** Every emoji in [text], whole (skin tones and joined families kept together). */
const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

export type Wrapped = {
    since: number;
    until: number;
    sent: number;
    received: number;
    /** Conversations by number of messages, most first. */
    topChats: { chatGuid: string; handle: string | null; count: number; sent: number }[];
    /** Messages per hour of the day (0-23) and day of the week (0 = Sunday), in the Mac's time zone. */
    hours: number[];
    weekdays: number[];
    busiestDay: { date: string; count: number } | null;
    /** Days in a row with at least one message sent. */
    longestStreak: number;
    topEmoji: { emoji: string; count: number }[];
    firstMessageAt: number | null;
};

/**
 * Echo Wrapped: a year (or any stretch) of messages in numbers, worked out
 * from Echo's search index - so it's quick and never touches Apple's database.
 */
export const wrapped = (days = 365): Wrapped => {
    const db = EchoSearch.get().open();
    const until = Date.now();
    const since = until - Math.max(1, Math.min(days, 3650)) * 86_400_000;
    const rows = db.prepare("SELECT chat, handle, me, date, text FROM msg WHERE date >= ? AND date <= ?").all(since, until) as {
        chat: string; handle: string | null; me: number; date: number; text: string;
    }[];
    const chats = new Map<string, { chatGuid: string; handle: string | null; count: number; sent: number }>();
    const hours = new Array(24).fill(0);
    const weekdays = new Array(7).fill(0);
    const perDay = new Map<string, number>();
    const sentDays = new Set<string>();
    const emoji = new Map<string, number>();
    let sent = 0;
    const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    for (const r of rows) {
        const d = new Date(r.date);
        const key = dayKey(d);
        hours[d.getHours()]++;
        weekdays[d.getDay()]++;
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
        if (r.me) {
            sent++;
            sentDays.add(key);
            for (const e of r.text.match(EMOJI) ?? []) emoji.set(e, (emoji.get(e) ?? 0) + 1);
        }
        if (r.chat) {
            const c = chats.get(r.chat) ?? { chatGuid: r.chat, handle: null, count: 0, sent: 0 };
            c.count++;
            if (r.me) c.sent++;
            else c.handle = c.handle ?? r.handle;
            chats.set(r.chat, c);
        }
    }
    let busiestDay: Wrapped["busiestDay"] = null;
    for (const [date, count] of perDay) if (!busiestDay || count > busiestDay.count) busiestDay = { date, count };
    // Longest run of consecutive days with something sent.
    let longest = 0;
    for (const key of sentDays) {
        const [y, m, dd] = key.split("-").map(Number);
        const prev = dayKey(new Date(y, m - 1, dd - 1));
        if (sentDays.has(prev)) continue; // Only count from the start of a run.
        let run = 1;
        for (let i = 1; ; i++) {
            if (!sentDays.has(dayKey(new Date(y, m - 1, dd + i)))) break;
            run++;
        }
        longest = Math.max(longest, run);
    }
    const first = db.prepare("SELECT min(date) AS d FROM msg").get() as { d: number | null };
    return {
        since,
        until,
        sent,
        received: rows.length - sent,
        topChats: [...chats.values()].sort((a, b) => b.count - a.count).slice(0, 10),
        hours,
        weekdays,
        busiestDay,
        longestStreak: longest,
        topEmoji: [...emoji.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e, count]) => ({ emoji: e, count })),
        firstMessageAt: first?.d ?? null
    };
};
