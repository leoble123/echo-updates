import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";
import { Message } from "@server/databases/imessage/entity/Message";

export type SearchHit = {
    guid: string;
    chatGuid: string;
    handle: string | null;
    isFromMe: boolean;
    date: number;
    /** The matching part of the message, with the matched words wrapped in [ and ]. */
    snippet: string;
};

const BATCH = 1500;

/** Turns what someone typed into an FTS5 query: every word must appear, as a word or the start of one. */
export const toFtsQuery = (raw: string): string | null => {
    const words = String(raw ?? "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .map(w => w.replace(/'/g, ""))
        .filter(w => w.length > 0)
        .slice(0, 12);
    if (!words.length) return null;
    return words.map(w => `"${w}"*`).join(" ");
};

/**
 * Full-history search. Messages keeps most text in attributedBody (not the
 * text column) on recent macOS, which a plain LIKE never sees, and a LIKE over
 * hundreds of thousands of rows is slow anyway. So the engine keeps its own
 * full-text index: built once in the background, then topped up every minute.
 */
export class EchoSearch extends Loggable {
    tag = "EchoSearch";

    private static instance: EchoSearch;

    static get() {
        EchoSearch.instance ??= new EchoSearch();
        return EchoSearch.instance;
    }

    static file = path.join(os.homedir(), "Library", "Application Support", "Echo", "search.db");

    private db: Database.Database = null;

    private running = false;

    private timer: NodeJS.Timeout = null;

    indexed = 0;

    newest = 0;

    lastIndexedRow = 0;

    open() {
        if (this.db) return this.db;
        fs.mkdirSync(path.dirname(EchoSearch.file), { recursive: true });
        const db = new Database(EchoSearch.file);
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        db.exec(`
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            CREATE TABLE IF NOT EXISTS msg (
                rowid INTEGER PRIMARY KEY, guid TEXT NOT NULL, chat TEXT, handle TEXT,
                me INTEGER, date INTEGER, text TEXT
            );
            CREATE INDEX IF NOT EXISTS msg_chat_date ON msg (chat, date);
            CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
                text, content='msg', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2', prefix='2 3'
            );
        `);
        this.db = db;
        const last = db.prepare("SELECT v FROM meta WHERE k = 'last_row'").get() as { v: string } | undefined;
        this.lastIndexedRow = Number(last?.v ?? 0) || 0;
        this.indexed = (db.prepare("SELECT count(*) AS n FROM msg").get() as { n: number }).n;
        return db;
    }

    start() {
        if (this.timer) return;
        // Let the engine settle before the first (possibly long) pass.
        setTimeout(() => this.catchUp(), 30_000);
        this.timer = setInterval(() => this.catchUp(), 60_000);
    }

    /** Indexes everything newer than the last indexed row, a batch at a time, yielding in between. */
    async catchUp() {
        if (this.running || !Server().iMessageRepo?.db?.isInitialized) return;
        this.running = true;
        try {
            const db = this.open();
            const insertMsg = db.prepare(
                "INSERT OR REPLACE INTO msg (rowid, guid, chat, handle, me, date, text) VALUES (?, ?, ?, ?, ?, ?, ?)"
            );
            const insertFts = db.prepare("INSERT INTO fts (rowid, text) VALUES (?, ?)");
            const setLast = db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_row', ?)");
            const repo = Server().iMessageRepo.db.getRepository(Message);
            const started = Date.now();
            let added = 0;
            for (;;) {
                const batch = await repo
                    .createQueryBuilder("message")
                    .leftJoinAndSelect("message.handle", "handle")
                    .leftJoinAndSelect("message.chats", "chat")
                    .where("message.ROWID > :rid", { rid: this.lastIndexedRow })
                    .orderBy("message.ROWID", "ASC")
                    .limit(BATCH)
                    .getMany();
                if (!batch.length) break;
                const rows: [number, string, string, string, number, number, string][] = [];
                let maxRow = this.lastIndexedRow;
                for (const m of batch) {
                    maxRow = Math.max(maxRow, m.ROWID);
                    // Tapbacks and group events aren't worth finding.
                    if ((Number(m.associatedMessageType) || 0) !== 0 || (m.itemType ?? 0) !== 0) continue;
                    let text = "";
                    try {
                        text = [m.subject, m.universalText(true)].filter(Boolean).join(" ").trim();
                    } catch {
                        text = (m.text ?? "").trim();
                    }
                    if (!text) continue;
                    rows.push([
                        m.ROWID,
                        m.guid,
                        m.chats?.[0]?.guid ?? null,
                        m.handle?.id ?? null,
                        m.isFromMe ? 1 : 0,
                        m.dateCreated ? m.dateCreated.getTime() : 0,
                        text.slice(0, 4000)
                    ]);
                }
                db.transaction(() => {
                    for (const r of rows) {
                        // A row seen before (rare: an edit re-indexed) must leave the index first.
                        const old = db.prepare("SELECT text FROM msg WHERE rowid = ?").get(r[0]) as { text: string } | undefined;
                        if (old) db.prepare("INSERT INTO fts (fts, rowid, text) VALUES ('delete', ?, ?)").run(r[0], old.text);
                        insertMsg.run(...r);
                        insertFts.run(r[0], r[6]);
                    }
                    setLast.run(String(maxRow));
                })();
                this.lastIndexedRow = maxRow;
                added += rows.length;
                this.indexed += rows.length;
                // Breathe between batches: the engine has messages to deliver.
                await new Promise(r => setTimeout(r, 40));
            }
            const newest = db.prepare("SELECT max(date) AS d FROM msg").get() as { d: number };
            this.newest = newest?.d ?? 0;
            if (added > 200) this.log.info(`Indexed ${added} messages in ${Math.round((Date.now() - started) / 1000)}s`);
        } catch (ex: any) {
            this.log.debug(`Indexing failed: ${ex?.message ?? String(ex)}`);
        } finally {
            this.running = false;
        }
    }

    get status() {
        return { indexed: this.indexed, building: this.running, lastRow: this.lastIndexedRow };
    }

    search(raw: string, opts: { chat?: string; fromMe?: boolean; limit?: number; offset?: number } = {}): SearchHit[] {
        const q = toFtsQuery(raw);
        if (!q) return [];
        const db = this.open();
        const where = ["fts MATCH ?"];
        const args: any[] = [q];
        if (opts.chat) {
            // Either spelling of the chat (macOS 26 says any;-;, older iMessage;-;).
            where.push("(m.chat = ? OR substr(m.chat, instr(m.chat, ';')) = substr(?, instr(?, ';')))");
            args.push(opts.chat, opts.chat, opts.chat);
        }
        if (opts.fromMe !== undefined) {
            where.push("m.me = ?");
            args.push(opts.fromMe ? 1 : 0);
        }
        const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
        const offset = Math.max(Number(opts.offset) || 0, 0);
        const rows = db
            .prepare(
                `SELECT m.guid, m.chat, m.handle, m.me, m.date, snippet(fts, 0, '[', ']', '…', 16) AS s
                 FROM fts JOIN msg m ON m.rowid = fts.rowid
                 WHERE ${where.join(" AND ")}
                 ORDER BY m.date DESC LIMIT ${limit} OFFSET ${offset}`
            )
            .all(...args) as any[];
        return rows.map(r => ({
            guid: r.guid,
            chatGuid: r.chat,
            handle: r.handle,
            isFromMe: r.me === 1,
            date: r.date,
            snippet: r.s
        }));
    }
}
