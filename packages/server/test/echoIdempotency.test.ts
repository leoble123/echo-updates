// Run: node --experimental-strip-types --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    IdempotencyLedger,
    KEEP_MS,
    STALE_MS,
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
    const { ledger, clock } = await ledgerAt();
    await ledger.claim("cut", "chat-A"); // never settled: the server died here
    await ledger.claim("fresh", "chat-A");
    clock.now += STALE_MS + 1;
    await ledger.claim("fresh", "chat-A"); // still busy, not touched below
    assert.equal(await ledger.reconcile(), 2);
    assert.equal((await ledger.claim("cut", "chat-A")).kind, "unknown");
});

test("reconcile leaves a send that just started alone", async () => {
    const { ledger } = await ledgerAt();
    await ledger.claim("k", "chat-A");
    assert.equal(await ledger.reconcile(), 0);
    assert.equal((await ledger.claim("k", "chat-A")).kind, "busy");
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
