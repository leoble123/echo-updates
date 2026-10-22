import crypto from "crypto";

/**
 * The smallest database surface the ledger needs. TypeORM's DataSource.query
 * fits it in the server; the tests hand it an in-memory SQLite.
 */
export type SqlRunner = { query(sql: string, params?: any[]): Promise<any[]> };

export type Claim =
    // Nobody has sent this yet (or the last try surely failed): go ahead, and
    // report back with complete/fail using this token.
    | { kind: "new"; token: string }
    // It went: here is what the first send answered.
    | { kind: "done"; result: any }
    // Another request with this key is sending right now.
    | { kind: "busy" }
    // A try ended without knowing whether it went (a timeout, or the server
    // stopped mid-send). Held for a while instead of sent again blind.
    | { kind: "unknown" }
    // The key was used for a different conversation.
    | { kind: "conflict" };

/**
 * A phone's word that it read the Mac's history for this conversation and
 * the exact send (by token) never landed. Lets a person's Try Again past the
 * hold on an outcome-unknown send - only when the Mac can confirm it's
 * still true (see [retryAuthProblem]).
 */
export type RetryAuth = {
    /** The send token (tempGuid) this confirmation is for. */
    key: string;
    chatGuid: string;
    /** What the phone found. Only "not_delivered" authorizes anything. */
    result: string;
    /** The newest message ROWID in the history the phone read (0 if the chat was empty). */
    seenThroughRowId: number;
    /** The oldest message date (Mac clock, ms) that history reached; 0 means the whole chat. */
    coveredFrom: number;
    /** The ROWID of every sent-from-me message in the history read - each one checked and not this send. */
    seenFromMe: number[];
};

/** What this Mac's own chat database says, read when a confirmation is checked. */
export type MacView = {
    /** The newest sent-from-me ROWID in the conversation (0 if none). */
    newestFromMe: number;
    /**
     * Every sent-from-me ROWID since the attempt began, in the conversation or
     * not filed to any conversation yet. Messages writes a sent message at
     * once but can file it to its chat later (seen on a real Mac), so an
     * unfiled one may be this very send - and the phone's history, read by
     * conversation, can't have seen it.
     */
    sinceAttempt: number[];
};

export const TABLE = "echo_idempotency";

/** How long a finished send is remembered. */
export const KEEP_MS = 24 * 60 * 60_000;

/**
 * How long an outcome-unknown send blocks a resend under the same key. Longer
 * than the phone keeps retrying on its own (15 minutes), so only a person's
 * Try Again - which checks the chat's history first - sends it again.
 */
export const UNKNOWN_HOLD_MS = 20 * 60_000;

/** The phone's history has to reach this far before the original attempt. */
export const COVER_MARGIN_MS = 2 * 60_000;

/**
 * Reads [MacView] from Messages' chat.db for [chatGuid], for sends since
 * [sinceMs] (Mac clock, ms). Read-only.
 */
export async function readMacView(chatDb: SqlRunner, chatGuid: string, sinceMs: number): Promise<MacView> {
    const newest = await chatDb.query(
        "SELECT MAX(m.ROWID) AS r FROM message m " +
            "JOIN chat_message_join j ON j.message_id = m.ROWID " +
            "JOIN chat c ON c.ROWID = j.chat_id " +
            "WHERE c.guid = ? AND m.is_from_me = 1",
        [chatGuid]
    );
    // message.date is nanoseconds since 2001; compared in ms so no number
    // past 2^53 crosses into JavaScript.
    const since = await chatDb.query(
        "SELECT m.ROWID AS r FROM message m " +
            "WHERE m.is_from_me = 1 AND m.date / 1000000 + 978307200000 >= ? AND (" +
            "EXISTS (SELECT 1 FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id " +
            "WHERE j.message_id = m.ROWID AND c.guid = ?) OR " +
            "NOT EXISTS (SELECT 1 FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id " +
            "WHERE j.message_id = m.ROWID)) ORDER BY m.ROWID",
        [sinceMs, chatGuid]
    );
    return {
        newestFromMe: Number(newest?.[0]?.r ?? 0),
        sinceAttempt: (since ?? []).map((x: any) => Number(x.r))
    };
}

/**
 * Why [auth] can't release this outcome-unknown send, or null if it can.
 * [mac] is read from this Mac's chat database just now, or null when that
 * couldn't be read - which never authorizes.
 */
export function retryAuthProblem(row: any, auth: RetryAuth | null | undefined, mac: MacView | null): string | null {
    if (!auth || typeof auth !== "object") return "no history confirmation";
    if (row?.status !== "unknown") return "only an outcome-unknown send can be released";
    if (auth.key !== row.key) return "confirmation is for a different send";
    if (auth.chatGuid !== row.chat_guid) return "confirmation is for a different conversation";
    if (auth.result !== "not_delivered") return "history didn't confirm it was missing";
    const seen = Number(auth.seenThroughRowId);
    const from = Number(auth.coveredFrom);
    if (!Number.isFinite(seen) || seen < 0 || !Number.isFinite(from) || from < 0) return "confirmation is malformed";
    if (!Array.isArray(auth.seenFromMe) || !auth.seenFromMe.every((n) => Number.isFinite(Number(n)))) {
        return "confirmation is malformed";
    }
    // The history read has to reach back before the attempt began, or the
    // send could be sitting just past what the phone looked at.
    if (from > Number(row.created_at) - COVER_MARGIN_MS) return "history didn't reach back far enough";
    if (mac == null) return "the Mac's history couldn't be read";
    // Anything sent from here since the phone looked could be this very
    // message landing late: the confirmation is stale.
    if (mac.newestFromMe > seen) return "history has changed since it was checked";
    // Every message sent since the attempt - filed to this chat or not filed
    // yet - has to be one the phone looked at and ruled out.
    const checked = new Set(auth.seenFromMe.map(Number));
    if (mac.sinceAttempt.some((id) => !checked.has(Number(id)))) {
        return "a message sent since the attempt wasn't in the history checked";
    }
    return null;
}

/**
 * A durable record of sends by their client token (tempGuid), so a resend
 * of a message that already went - after a dropped response, a reconnect,
 * or a server restart - answers with the first result instead of sending
 * it twice. The in-memory send cache only covered sends still in flight.
 */
export class IdempotencyLedger {
    private db: SqlRunner;

    private now: () => number;

    constructor(db: SqlRunner, now: () => number = Date.now) {
        this.db = db;
        this.now = now;
    }

    async ensureSchema(): Promise<void> {
        // Additive only: a new table, nothing existing is touched.
        await this.db.query(
            `CREATE TABLE IF NOT EXISTS "${TABLE}" (` +
                `"key" TEXT PRIMARY KEY NOT NULL, ` +
                `"chat_guid" TEXT NOT NULL, ` +
                `"status" TEXT NOT NULL, ` +
                `"token" TEXT NOT NULL, ` +
                `"result" TEXT, ` +
                `"created_at" INTEGER NOT NULL, ` +
                `"updated_at" INTEGER NOT NULL)`
        );
        await this.db.query(`CREATE INDEX IF NOT EXISTS "${TABLE}_created" ON "${TABLE}" ("created_at")`);
    }

    private async row(key: string): Promise<any | null> {
        const rows = await this.db.query(`SELECT * FROM "${TABLE}" WHERE "key" = ?`, [key]);
        return rows?.[0] ?? null;
    }

    /**
     * [verify] is asked only about an outcome-unknown send still in its hold:
     * true releases it to this request. The release is conditional on the
     * row being unchanged, so of several verified retries only one sends.
     */
    async claim(key: string, chatGuid: string, verify?: (row: any) => Promise<boolean>): Promise<Claim> {
        const now = this.now();
        const token = crypto.randomBytes(16).toString("hex");
        // Only one request can insert the row; whoever's token is on it owns the send.
        await this.db.query(
            `INSERT OR IGNORE INTO "${TABLE}" ("key", "chat_guid", "status", "token", "result", "created_at", "updated_at") ` +
                `VALUES (?, ?, 'in_progress', ?, NULL, ?, ?)`,
            [key, chatGuid ?? "", token, now, now]
        );
        let row = await this.row(key);
        if (!row) return { kind: "new", token }; // can't happen, but never block a send on it
        if (row.token === token) return { kind: "new", token };
        if (row.chat_guid !== (chatGuid ?? "")) return { kind: "conflict" };

        const retake =
            row.status === "failed" ||
            (row.status === "unknown" &&
                (now - row.updated_at >= UNKNOWN_HOLD_MS || (verify != null && (await verify(row)))));
        if (retake) {
            // Conditional on what was read, so two resends can't both take it.
            await this.db.query(
                `UPDATE "${TABLE}" SET "status" = 'in_progress', "token" = ?, "updated_at" = ? ` +
                    `WHERE "key" = ? AND "token" = ?`,
                [token, now, key, row.token]
            );
            row = await this.row(key);
            if (row?.token === token) return { kind: "new", token };
        }
        switch (row?.status) {
            case "done":
                return { kind: "done", result: row.result ? JSON.parse(row.result) : null };
            case "unknown":
                return { kind: "unknown" };
            default:
                return { kind: "busy" };
        }
    }

    private async finish(key: string, token: string, status: string, result: any = null): Promise<void> {
        await this.db.query(
            `UPDATE "${TABLE}" SET "status" = ?, "result" = ?, "updated_at" = ? WHERE "key" = ? AND "token" = ?`,
            [status, result == null ? null : JSON.stringify(result), this.now(), key, token]
        );
    }

    /** It went; [result] is replayed to any resend. */
    complete(key: string, token: string, result: any): Promise<void> {
        return this.finish(key, token, "done", result);
    }

    /** It surely didn't go (Messages reported an error): a resend may try again. */
    fail(key: string, token: string): Promise<void> {
        return this.finish(key, token, "failed");
    }

    /** It may or may not have gone. */
    unknown(key: string, token: string): Promise<void> {
        return this.finish(key, token, "unknown");
    }

    /** Forgets sends older than [KEEP_MS]. Returns how many. */
    async sweep(): Promise<number> {
        const cutoff = this.now() - KEEP_MS;
        const old = await this.db.query(`SELECT COUNT(*) AS n FROM "${TABLE}" WHERE "created_at" < ?`, [cutoff]);
        await this.db.query(`DELETE FROM "${TABLE}" WHERE "created_at" < ?`, [cutoff]);
        return Number(old?.[0]?.n ?? 0);
    }

    /**
     * After a restart: every send still in progress was cut off mid-way - its
     * process is gone - so whether it went is unknown. However recently it
     * began: a send cut off seconds into it is the usual case. Only call this
     * before this process claims anything (EchoIdempotency runs it when the
     * ledger opens, and every claim waits for that). Returns how many.
     */
    async reconcile(): Promise<number> {
        const stuck = await this.db.query(`SELECT COUNT(*) AS n FROM "${TABLE}" WHERE "status" = 'in_progress'`);
        await this.db.query(`UPDATE "${TABLE}" SET "status" = 'unknown', "updated_at" = ? WHERE "status" = 'in_progress'`, [
            this.now()
        ]);
        return Number(stuck?.[0]?.n ?? 0);
    }
}
