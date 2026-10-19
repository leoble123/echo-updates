// Run: node --experimental-strip-types --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    BrowserTokens,
    UNUSED_TOKEN_MS,
    credentialFrom,
    ownerOnly,
    roleFor,
    sameSecret
} from "../src/server/services/echoAuth/core.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "echoauth-")), "browsers.json");

test("header wins over query, query still works", () => {
    assert.equal(credentialFrom({ authorization: "Bearer abc" }, { password: "xyz" }), "abc");
    assert.equal(credentialFrom({}, { password: "xyz" }), "xyz");
    assert.equal(credentialFrom({}, { guid: "g" }), "g");
    assert.equal(credentialFrom({ authorization: "Basic zzz" }, {}), null);
});

test("password compare trims like before and rejects near misses", () => {
    assert.ok(sameSecret(" pw ", "pw"));
    assert.ok(!sameSecret("pw1", "pw"));
    assert.ok(!sameSecret("", "pw"));
});

test("browser tokens: mint, use, revoke, unused expiry, persisted hashed", () => {
    const file = tmp();
    const store = new BrowserTokens(file);
    const now = 5_000_000;
    const { id, token } = store.mint("Chrome on PC", now);
    assert.equal(roleFor(token, "pw", store, now + 1000), "browser");
    assert.equal(roleFor("pw", "pw", store, now), "owner");
    assert.equal(roleFor("nope", "pw", store, now), null);
    assert.ok(!fs.readFileSync(file, "utf8").includes(token), "token never stored in plain");
    // A fresh store reads it back.
    assert.equal(roleFor(token, "pw", new BrowserTokens(file), now + 2000), "browser");
    assert.equal(store.revoke([id]), 1);
    assert.equal(roleFor(token, "pw", store, now + 3000), null);

    const unused = store.mint("Never used", now);
    assert.equal(roleFor(unused.token, "pw", store, now + UNUSED_TOKEN_MS + 1), null);
    const used = store.mint("Used", now);
    assert.ok(store.check(used.token, now + 1000));
    assert.ok(store.check(used.token, now + UNUSED_TOKEN_MS * 10), "once used, it stays");
    assert.equal(store.all(now + UNUSED_TOKEN_MS * 10).some(b => "hash" in b), false);
    const named = store.mint("Browser", now);
    assert.ok(store.rename(named.token, "Chrome on Windows", now + 5));
    assert.equal(store.all().find(b => b.id === named.id)?.name, "Chrome on Windows");
    assert.ok(!store.rename("eb_nope", "x"));
    const leaving = store.mint("Leaving", now);
    store.check(leaving.token, now + 1);
    assert.ok(store.revokeToken(leaving.token, now + 2));
    assert.equal(roleFor(leaving.token, "pw", store, now + 2), null);
    assert.ok(!store.revokeToken("eb_unknown"));
    assert.ok(!ownerOnly("POST", "/api/v1/echo/browser/leave"));
    store.revoke(null);
    assert.equal(store.all().length, 0);
});

test("browsers can't change the password or manage browsers", () => {
    assert.ok(ownerOnly("POST", "/api/v1/echo/password"));
    assert.ok(ownerOnly("POST", "/api/v1/echo/browsers"));
    assert.ok(ownerOnly("GET", "/api/v1/echo/browsers"));
    assert.ok(ownerOnly("POST", "/api/v1/echo/browsers/revoke"));
    assert.ok(ownerOnly("POST", "/api/v1/echo/settings"));
    assert.ok(!ownerOnly("GET", "/api/v1/echo/settings"));
    assert.ok(!ownerOnly("GET", "/api/v1/echo/status"));
    assert.ok(!ownerOnly("POST", "/api/v1/message/text"));
});
