// Test: sidecar lifecycle race regression guard.
// Run: node tests/test-sidecar-race.mjs
//
// Before the fix: two near-simultaneous syncVisibility(armed) calls both
// passed the `if (!server)` check and each started a server + browser window.
// After the fix: they're serialized, so only one server starts.

import assert from "node:assert/strict";
import { createSidecar } from "../sidecar.mjs";

function makeFakeController() {
    return {
        async pause() {}, async resume() {}, async clearObjective() {},
        async turnOff() {}, async turnOn() {},
        get snapshot() { return { enabled: true, status: "idle" }; },
    };
}

async function run() {
    const log = async () => {};
    const sidecar = createSidecar({
        controller: makeFakeController(),
        sessionId: "race-test",
        log,
        noLaunch: true,
    });

    const armed = { enabled: true, status: "armed", goal: "x", hardCap: 1, continuationsFired: 0 };

    // Fire two visible calls + one hidden call back-to-back.
    // Without the lock the two armed calls would each start their own server.
    const [a, b, c] = [
        sidecar.syncVisibility(armed),
        sidecar.syncVisibility(armed),
        sidecar.syncVisibility({ enabled: true, status: "idle" }),
    ];
    await Promise.all([a, b, c]);

    // Final state was idle → server should be down. (If the race fired, we'd
    // either still have a server up or we'd have leaked one.)
    assert.equal(sidecar.isRunning, false, "after racing visible/hidden, ends in declared state");

    // Repeat in the opposite order: hidden, visible, visible.
    const [d, e, f] = [
        sidecar.syncVisibility({ enabled: true, status: "idle" }),
        sidecar.syncVisibility(armed),
        sidecar.syncVisibility(armed),
    ];
    await Promise.all([d, e, f]);
    assert.equal(sidecar.isRunning, true, "ends visible after race");

    // Capture port; fire two more armed updates concurrently — port must NOT change
    // (would prove only one server lives).
    const port1 = sidecar.port;
    await Promise.all([sidecar.syncVisibility(armed), sidecar.syncVisibility(armed)]);
    assert.equal(sidecar.port, port1, "port is stable across concurrent visible updates");

    await sidecar.shutdown();
    assert.equal(sidecar.isRunning, false, "shutdown takes server down");

    console.log("✓ test-sidecar-race: 3/3 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
