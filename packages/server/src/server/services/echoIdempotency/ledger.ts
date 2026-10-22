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

export const TABLE = "echo_idempotency";

/** How long a finished send is remembered. */
export const KEEP_MS = 24 * 60 * 60_000;

/** A send still marked in progress this long after it began was cut off. */
export const STALE_MS = 2 * 60_000;

/**
 * How long an outcome-unknown send blocks a resend under the same key. Longer
 * than the phone keeps retrying on its own (15 minutes), so only a person's
 * Try Again - which checks the chat's history first - sends it again.
 */
export const UNKNOWN_HOLD_MS = 20 * 60_000;

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

    async claim(key: string, chatGuid: string): Promise<Claim> {
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
            (row.status === "unknown" && now - row.updated_at >= UNKNOWN_HOLD_MS);
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
     * After a restart: a send still in progress was cut off mid-way, so
     * whether it went is unknown. Returns how many were marked.
     */
    async reconcile(): Promise<number> {
        const now = this.now();
        const cutoff = now - STALE_MS;
        const stuck = await this.db.query(
            `SELECT COUNT(*) AS n FROM "${TABLE}" WHERE "status" = 'in_progress' AND "updated_at" < ?`,
            [cutoff]
        );
        await this.db.query(
            `UPDATE "${TABLE}" SET "status" = 'unknown', "updated_at" = ? WHERE "status" = 'in_progress' AND "updated_at" < ?`,
            [now, cutoff]
        );
        return Number(stuck?.[0]?.n ?? 0);
    }
}
