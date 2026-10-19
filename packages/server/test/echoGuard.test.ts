// Run: node --experimental-strip-types --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { HELPER_RELAUNCH_GAP_MS, helperStep, lastRelaunch } from "../src/server/services/echoGuard/policy.ts";

test("helper: two reconnects, then a relaunch", () => {
    assert.equal(helperStep(0, 0, 10 * HELPER_RELAUNCH_GAP_MS, false), "repair");
    assert.equal(helperStep(1, 0, 10 * HELPER_RELAUNCH_GAP_MS, false), "repair");
    assert.equal(helperStep(2, 0, 10 * HELPER_RELAUNCH_GAP_MS, false), "relaunch");
});

test("helper: never two relaunches within two hours", () => {
    const now = 100 * HELPER_RELAUNCH_GAP_MS;
    assert.equal(helperStep(2, now - 3600_000, now, false), "wait");
    assert.equal(helperStep(2, now - HELPER_RELAUNCH_GAP_MS - 1, now, false), "relaunch");
});

test("helper: never relaunches mid-send", () => {
    assert.equal(helperStep(2, 0, 10 * HELPER_RELAUNCH_GAP_MS, true), "wait");
});

test("last relaunch is read from the newest matching event", () => {
    const m = "Relaunching: helper";
    assert.equal(lastRelaunch([], m), 0);
    assert.equal(lastRelaunch([{ at: 1, text: m }, { at: 5, text: "other" }, { at: 3, text: m + " x" }], m), 3);
});
