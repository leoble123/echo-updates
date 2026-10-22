// Run: node --experimental-sqlite --experimental-strip-types --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    COVER_MARGIN_MS,
    IdempotencyLedger,
    KEEP_MS,
    readMacView,
    retryAuthProblem,
    type MacView,
    type RetryAuth,
    TABLE,
    UNKNOWN_HOLD_MS,
    type SqlRunner
} from "../src/server/services/echoIdempotency/ledger.ts";

/** The ledger's SqlRunner over node's SQLite, the same engine the server's config.db uses. */
function runner(db: DatabaseSync): SqlRunner {
    return {
        async query(sql: string, params: any[] = []) {
            const st = db.prepare(sql);
            return /^\s*SELECT/i.test(sql) ? (st.all(...params) as any[]) : (st.run(...params), []);
        }
    };
}

async function ledgerAt(file = ":memory:") {
    const clock = { now: 1_000_000 };
    const db = new DatabaseSync(file);
    const ledger = new IdempotencyLedger(runner(db), () => clock.now);
    await ledger.ensureSchema();
    return { ledger, clock, db };
}

/** A fake send: counts how many times Messages was asked. */
async function send(ledger: IdempotencyLedger, key: string, chat: string, counter: { n: number }, outcome = "done") {
    const claim = await ledger.claim(key, chat);
    if (claim.kind !== "new") return claim;
    counter.n++;
    if (outcome === "done") await ledger.complete(key, claim.token, { guid: `apple-${counter.n}`, tempGuid: key });
    else if (outcome === "failed") await ledger.fail(key, claim.token);
    else await ledger.unknown(key, claim.token);
    return claim;
}

test("first send goes; a resend with the same key replays it without sending again", async () => {
    const { ledger } = await ledgerAt();
    const sent = { n: 0 };
    assert.equal((await send(ledger, "echo-local-1", "chat-A", sent)).kind, "new");
    const again = await ledger.claim("echo-local-1", "chat-A");
    assert.equal(again.kind, "done");
    assert.deepEqual((again as any).result, { guid: "apple-1", tempGuid: "echo-local-1" });
    assert.equal(sent.n, 1);
});

test("different keys are independent", async () => {
    const { ledger } = await ledgerAt();
    const sent = { n: 0 };
    await send(ledger, "k1", "chat-A", sent);
    await send(ledger, "k2", "chat-A", sent);
    assert.equal(sent.n, 2);
});

test("a send in flight blocks a concurrent resend", async () => {
    const { ledger } = await ledgerAt();
    const first = await ledger.claim("k", "chat-A");
    assert.equal(first.kind, "new");
    assert.equal((await ledger.claim("k", "chat-A")).kind, "busy");
});

test("two simultaneous claims: exactly one wins", async () => {
    const { ledger } = await ledgerAt();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ledger.claim("race", "chat-A")));
    assert.equal(results.filter((r) => r.kind === "new").length, 1);
});

test("a failed send (Messages reported an error) may be sent again", async () => {
    const { ledger } = await ledgerAt();
    const sent = { n: 0 };
    await send(ledger, "k", "chat-A", sent, "failed");
    assert.equal((await send(ledger, "k", "chat-A", sent)).kind, "new");
    assert.equal(sent.n, 2);
    assert.equal((await ledger.claim("k", "chat-A")).kind, "done");
});

test("an outcome-unknown send is held, then released after the hold", async () => {
    const { ledger, clock } = await ledgerAt();
    const sent = { n: 0 };
    await send(ledger, "k", "chat-A", sent, "unknown");
    assert.equal((await ledger.claim("k", "chat-A")).kind, "unknown");
    clock.now += UNKNOWN_HOLD_MS - 1;
    assert.equal((await ledger.claim("k", "chat-A")).kind, "unknown");
    clock.now += 1;
    assert.equal((await send(ledger, "k", "chat-A", sent)).kind, "new");
    assert.equal(sent.n, 2);
});

test("a key reused for another conversation is refused", async () => {
    const { ledger } = await ledgerAt();
    await send(ledger, "k", "chat-A", { n: 0 });
    assert.equal((await ledger.claim("k", "chat-B")).kind, "conflict");
});

test("a stale token can't overwrite a newer attempt", async () => {
    const { ledger } = await ledgerAt();
    const first = await ledger.claim("k", "chat-A");
    await ledger.fail("k", (first as any).token);
    const second = await ledger.claim("k", "chat-A");
    assert.equal(second.kind, "new");
    // The first attempt reports late: ignored, the second still owns it.
    await ledger.complete("k", (first as any).token, { guid: "late" });
    assert.equal((await ledger.claim("k", "chat-A")).kind, "busy");
    await ledger.complete("k", (second as any).token, { guid: "real" });
    assert.deepEqual(((await ledger.claim("k", "chat-A")) as any).result, { guid: "real" });
});

test("survives a restart: a finished send is still replayed from disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-idem-"));
    const file = path.join(dir, "config.db");
    try {
        const a = await ledgerAt(file);
        const sent = { n: 0 };
        await send(a.ledger, "k", "chat-A", sent);
        a.db.close();

        const b = await ledgerAt(file); // a fresh process opening the same database
        assert.equal((await b.ledger.claim("k", "chat-A")).kind, "done");
        assert.equal(sent.n, 1);
        b.db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("after a crash mid-send, reconcile holds it as unknown instead of resending", async () => {
    const { ledger } = await ledgerAt();
    await ledger.claim("cut", "chat-A"); // never settled: the server died here
    await send(ledger, "went", "chat-A", { n: 0 }); // finished before the crash: left alone
    assert.equal(await ledger.reconcile(), 1);
    assert.equal((await ledger.claim("cut", "chat-A")).kind, "unknown");
    assert.equal((await ledger.claim("went", "chat-A")).kind, "done");
});

test("reconcile holds even a send cut off seconds after it began (regression)", async () => {
    // It used to skip sends younger than two minutes - so a quick restart
    // mid-send left them in progress, and every resend was refused as busy.
    const { ledger, clock } = await ledgerAt();
    await ledger.claim("k", "chat-A");
    clock.now += 1000;
    assert.equal(await ledger.reconcile(), 1);
    assert.equal((await ledger.claim("k", "chat-A")).kind, "unknown");
    clock.now += UNKNOWN_HOLD_MS;
    assert.equal((await ledger.claim("k", "chat-A")).kind, "new");
});

test("sweep forgets sends older than a day, and keeps the rest", async () => {
    const { ledger, clock, db } = await ledgerAt();
    const sent = { n: 0 };
    await send(ledger, "old", "chat-A", sent);
    clock.now += KEEP_MS - 1000;
    await send(ledger, "new", "chat-A", sent);
    clock.now += 2000;
    assert.equal(await ledger.sweep(), 1);
    const left = db.prepare(`SELECT "key" FROM "${TABLE}"`).all().map((r: any) => r.key);
    assert.deepEqual(left, ["new"]);
    // Forgotten means a resend under that key goes again - a day later, that's intended.
    assert.equal((await ledger.claim("old", "chat-A")).kind, "new");
});

test("schema creation is additive and repeatable", async () => {
    const { ledger, db } = await ledgerAt();
    db.exec(`CREATE TABLE "config" ("name" TEXT PRIMARY KEY, "value" TEXT)`);
    db.prepare(`INSERT INTO "config" VALUES ('echo_idempotency', '0')`).run();
    await ledger.ensureSchema();
    await ledger.ensureSchema();
    assert.deepEqual(db.prepare(`SELECT * FROM "config"`).all().length, 1);
});

// --- history-confirmed retry ------------------------------------------------

/** A Mac whose chat database says the newest sent-from-me ROWID is [newest] (null: unreadable). */
function mac(newest: number | null, sinceAttempt: number[] = []): MacView | null {
    return newest == null ? null : { newestFromMe: newest, sinceAttempt };
}

function verifier(ledger: IdempotencyLedger, m: MacView | null, auth: RetryAuth | null) {
    return async (row: any) => {
        await new Promise((r) => setImmediate(r)); // the Mac lookup is real I/O: let others interleave
        return retryAuthProblem(row, auth, m) == null;
    };
}

/** An outcome-unknown send in chat-A, created at the ledger's current time. */
async function unknownSend(ledger: IdempotencyLedger, key = "echo-local-G") {
    const c = await ledger.claim(key, "chat-A");
    await ledger.unknown(key, (c as any).token);
}

function confirmation(over: Partial<RetryAuth> = {}): RetryAuth {
    return { key: "echo-local-G", chatGuid: "chat-A", result: "not_delivered", seenThroughRowId: 500, coveredFrom: 0, seenFromMe: [], ...over };
}

test("confirmed not delivered: a verified retry goes now, inside the hold", async () => {
    const { ledger, clock } = await ledgerAt();
    await unknownSend(ledger);
    clock.now += 60_000; // well inside the 20 minutes
    const c = await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), confirmation()));
    assert.equal(c.kind, "new");
});

test("confirmed delivered: a confirmation that doesn't say 'not delivered' releases nothing", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    const auth = confirmation({ result: "delivered" });
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), auth))).kind, "unknown");
});

test("unavailable history: no confirmation, or the Mac can't read its own, keeps the hold", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), null))).kind, "unknown");
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(null), confirmation()))).kind, "unknown");
    assert.equal(retryAuthProblem({ status: "unknown", key: "echo-local-G", chat_guid: "chat-A", created_at: 1e9 }, confirmation(), null),
        "the Mac's history couldn't be read");
});

test("stale confirmation: something sent from me since the phone looked keeps the hold", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    // The original landing late would be exactly this: a newer from-me row.
    const c = await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(501), confirmation({ seenThroughRowId: 500 })));
    assert.equal(c.kind, "unknown");
});

test("incomplete history: a read that doesn't reach back before the attempt keeps the hold", async () => {
    const { ledger, clock } = await ledgerAt();
    await unknownSend(ledger); // created at clock.now
    const attempt = clock.now;
    const short = confirmation({ coveredFrom: attempt - COVER_MARGIN_MS + 1 });
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), short))).kind, "unknown");
    const enough = confirmation({ coveredFrom: attempt - COVER_MARGIN_MS });
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), enough))).kind, "new");
});

test("bound to the send token and conversation, not the text", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    const otherSend = confirmation({ key: "echo-local-OTHER" });
    const otherChat = confirmation({ chatGuid: "chat-B" });
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), otherSend))).kind, "unknown");
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), otherChat))).kind, "unknown");
    assert.equal(retryAuthProblem({ status: "unknown", key: "k", chat_guid: "c", created_at: 1e9 }, { key: "k", chatGuid: "c", result: "not_delivered", seenThroughRowId: "x" as any, coveredFrom: 0, seenFromMe: [] }, 0),
        "confirmation is malformed");
});

test("concurrent verified retries: exactly one sends", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    const results = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), confirmation())))
    );
    assert.equal(results.filter((r) => r.kind === "new").length, 1);
    assert.ok(results.every((r) => r.kind === "new" || r.kind === "busy"), JSON.stringify(results));
});

test("a confirmation never overrides a send that went, or one in flight", async () => {
    const { ledger } = await ledgerAt();
    await send(ledger, "echo-local-G", "chat-A", { n: 0 });
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), confirmation()))).kind, "done");
    await ledger.claim("echo-local-F", "chat-A");
    const auth = confirmation({ key: "echo-local-F" });
    assert.equal((await ledger.claim("echo-local-F", "chat-A", verifier(ledger, mac(500), auth))).kind, "busy");
});

test("server restart: a send cut off mid-way is held, then released by a fresh confirmation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-idem-"));
    const file = path.join(dir, "config.db");
    try {
        const a = await ledgerAt(file);
        await a.ledger.claim("echo-local-G", "chat-A"); // the server dies before settling
        a.db.close();

        const b = await ledgerAt(file);
        b.clock.now = a.clock.now + 5_000; // a quick restart
        assert.equal(await b.ledger.reconcile(), 1);
        assert.equal((await b.ledger.claim("echo-local-G", "chat-A")).kind, "unknown");
        // A stale read is still refused after the restart...
        assert.equal((await b.ledger.claim("echo-local-G", "chat-A", verifier(b.ledger, mac(9), confirmation({ seenThroughRowId: 8 })))).kind, "unknown");
        // ...and a current one releases it, once.
        const ok = verifier(b.ledger, mac(8), confirmation({ seenThroughRowId: 8 }));
        assert.equal((await b.ledger.claim("echo-local-G", "chat-A", ok)).kind, "new");
        assert.equal((await b.ledger.claim("echo-local-G", "chat-A", ok)).kind, "busy");
        b.db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- what a real Mac showed: a sent message isn't filed to its chat at once ---

test("a sent message not yet filed to any chat, unseen by the phone, keeps the hold", async () => {
    // On a real Mac a message sent offline appeared in chat.db at once, but
    // with no chat - so the phone's history (read by chat) couldn't see it.
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    const m = mac(500, [501]); // 501: from me, since the attempt, not filed yet
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, m, confirmation({ seenThroughRowId: 500 })))).kind, "unknown");
});

test("filed later under a lower ROWID than the phone's newest, still unseen: hold", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    // 498 was unfiled when the phone looked; a reply (500) came in after it.
    const m = mac(498, [498]);
    const auth = confirmation({ seenThroughRowId: 500, seenFromMe: [] });
    assert.equal(retryAuthProblem({ status: "unknown", key: "echo-local-G", chat_guid: "chat-A", created_at: 1e12 }, auth, m),
        "a message sent since the attempt wasn't in the history checked");
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, m, auth))).kind, "unknown");
});

test("every message sent since the attempt was checked by the phone: released", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    const auth = confirmation({ seenThroughRowId: 500, seenFromMe: [480, 498, 499] });
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(499, [498, 499]), auth))).kind, "new");
});

test("a confirmation without the list of messages checked releases nothing", async () => {
    const { ledger } = await ledgerAt();
    await unknownSend(ledger);
    const auth = confirmation();
    delete (auth as any).seenFromMe;
    assert.equal((await ledger.claim("echo-local-G", "chat-A", verifier(ledger, mac(500), auth))).kind, "unknown");
});

/** A chat.db with the tables and columns readMacView reads, dates as Messages stores them. */
function chatDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, is_from_me INTEGER, date INTEGER);
             CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT);
             CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
             INSERT INTO chat (guid) VALUES ('any;+;chat515870701682263854'), ('any;-;lgreen114@icloud.com');`);
    const add = (ms: number, fromMe: number, chat: number | null) => {
        // Nanoseconds since 2001, the way Messages stores it - past 2^53, so built as a BigInt.
        const ns = (BigInt(ms) - 978307200000n) * 1000000n + 123456n;
        const r = db.prepare("INSERT INTO message (text, is_from_me, date) VALUES ('x', ?, ?)").run(fromMe, ns);
        if (chat != null) db.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, r.lastInsertRowid);
        return Number(r.lastInsertRowid);
    };
    return { db, add };
}

test("readMacView on a chat.db: this chat's and unfiled sends since the attempt, nothing else", async () => {
    const { db, add } = chatDb();
    const t = 1_792_652_827_000; // October 2026
    const before = add(t - 600_000, 1, 1); // sent in this chat, before the window
    const mine = add(t + 1_000, 1, 1); // sent in this chat, in the window
    const elsewhere = add(t + 2_000, 1, 2); // sent in another chat
    const incoming = add(t + 3_000, 0, 1); // received
    const unfiled = add(t + 4_000, 1, null); // sent, not filed to a chat yet
    const v = await readMacView(runner(db), "any;+;chat515870701682263854", t);
    assert.deepEqual(v.sinceAttempt, [mine, unfiled]);
    assert.equal(v.newestFromMe, mine);
    assert.ok(![before, elsewhere, incoming].some((id) => v.sinceAttempt.includes(id)));
    // The window edge is exact to the millisecond, despite nanosecond dates.
    const edge = await readMacView(runner(db), "any;+;chat515870701682263854", t + 1_000);
    assert.deepEqual(edge.sinceAttempt, [mine, unfiled]);
    const past = await readMacView(runner(db), "any;+;chat515870701682263854", t + 1_001);
    assert.deepEqual(past.sinceAttempt, [unfiled]);
});

test("readMacView: once the unfiled send is filed to the chat, it still counts", async () => {
    const { db, add } = chatDb();
    const t = 1_792_652_827_000;
    const id = add(t + 1_000, 1, null);
    assert.deepEqual((await readMacView(runner(db), "any;+;chat515870701682263854", t)).sinceAttempt, [id]);
    db.prepare("INSERT INTO chat_message_join VALUES (1, ?)").run(id);
    const v = await readMacView(runner(db), "any;+;chat515870701682263854", t);
    assert.deepEqual(v.sinceAttempt, [id]);
    assert.equal(v.newestFromMe, id);
    // Filed to a different chat, it no longer concerns this one.
    const other = add(t + 2_000, 1, 2);
    assert.ok(!(await readMacView(runner(db), "any;+;chat515870701682263854", t)).sinceAttempt.includes(other));
});
