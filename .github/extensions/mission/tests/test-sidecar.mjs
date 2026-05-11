// Test: sidecar HTTP/WS contract (no browser launch).
// Run: node tests/test-sidecar.mjs

import assert from "node:assert/strict";
import { request as httpRequest, get as httpGet } from "node:http";
import { createSidecar } from "../sidecar.mjs";

function makeFakeController() {
    const calls = [];
    const snapshot = { enabled: true, status: "idle", goal: null };
    return {
        async pause()          { calls.push("pause"); },
        async resume()         { calls.push("resume"); },
        async clearObjective() { calls.push("clear"); },
        async turnOff()        { calls.push("off"); },
        async turnOn()         { calls.push("on"); },
        get snapshot()         { return snapshot; },
        _calls: calls,
        _snapshot: snapshot,
    };
}

function logCollector() {
    const messages = [];
    return Object.assign(async (msg, opts) => { messages.push({ msg, opts }); }, { messages });
}

function postJson(host, port, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body), "utf8");
        const req = httpRequest({
            host, port, path, method: "POST",
            headers: { "content-type": "application/json", "content-length": data.length, ...headers },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

function getRaw(host, port, path) {
    return new Promise((resolve, reject) => {
        httpGet({ host, port, path }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        }).on("error", reject);
    });
}

async function pollUntil(predicate, timeoutMs = 2000, intervalMs = 25) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

async function run() {
    const controller = makeFakeController();
    const log = logCollector();
    const sidecar = createSidecar({ controller, sessionId: "test-session-abc12345", log, noLaunch: true });

    // Case 1: idle → no server.
    assert.equal(sidecar.isRunning, false, "case 1: starts not-running");
    await sidecar.syncVisibility({ enabled: true, status: "idle" });
    assert.equal(sidecar.isRunning, false, "case 1: idle keeps server down");

    // Case 2: armed → server up.
    const armedState = {
        enabled: true, status: "armed", goal: "test goal",
        hardCap: 5, continuationsFired: 1, remainingTurns: 4,
        createdAt: new Date().toISOString(), lastFiredAt: null, inFlight: false,
    };
    await sidecar.syncVisibility(armedState);
    assert.equal(sidecar.isRunning, true, "case 2: armed brings server up");

    // Pull port from internal state via a /(GET / probe.
    // We need the port — fish it out of the underlying server.
    // The sidecar doesn't expose port directly; sniff via a temporary network probe.
    // Easier: use 127.0.0.1 + scan via the sidecar's own server reference.
    // Workaround: expose via a getter — but we can also just look at
    // sidecar.isRunning + try the well-known port range. Better: read
    // server.address() through reflection-ish access.
    // The cleanest path: since the sidecar object is opaque, add port as a
    // getter. (See sidecar.mjs follow-up.)
    const port = sidecar.port;
    assert.ok(typeof port === "number" && port > 0, "case 2: sidecar exposes port");

    // Case 3: GET / serves viewer HTML.
    const viewer = await getRaw("127.0.0.1", port, "/");
    assert.equal(viewer.status, 200, "case 3: GET / returns 200");
    assert.match(viewer.body, /<title>mission<\/title>/, "case 3: HTML has expected title");
    assert.match(viewer.body, /href="\/favicon\.svg"/, "case 3: HTML links favicon");

    const favicon = await getRaw("127.0.0.1", port, "/favicon.svg");
    assert.equal(favicon.status, 200, "case 3b: GET /favicon.svg returns 200");
    assert.match(favicon.body, /<svg\b/, "case 3b: favicon is SVG");

    const token = sidecar.token;
    assert.ok(typeof token === "string" && token.length > 0, "token exposed");

    // Case 4: POST /api/action without token → 401.
    const noAuth = await postJson("127.0.0.1", port, "/api/action", { action: "pause" });
    assert.equal(noAuth.status, 401, "case 4: missing token rejected");
    assert.equal(controller._calls.length, 0, "case 4: controller not called");

    // Case 5: POST /api/action with bad token → 401.
    const badAuth = await postJson("127.0.0.1", port, "/api/action",
        { action: "pause" }, { "x-token": "wrong-token" });
    assert.equal(badAuth.status, 401, "case 5: bad token rejected");

    // Case 6: POST /api/action with correct token dispatches to controller.
    const ok = await postJson("127.0.0.1", port, "/api/action",
        { action: "pause" }, { "x-token": token });
    assert.equal(ok.status, 200, "case 6: good action returns 200");
    // Action is dispatched async; poll briefly.
    const sawPause = await pollUntil(() => controller._calls.includes("pause"));
    assert.ok(sawPause, "case 6: controller.pause invoked");

    // Case 7: each known action routes correctly.
    for (const [action, name] of [
        ["resume", "resume"],
        ["clear",  "clear"],
        ["off",    "off"],
        ["on",     "on"],
    ]) {
        await postJson("127.0.0.1", port, "/api/action", { action }, { "x-token": token });
        const saw = await pollUntil(() => controller._calls.includes(name));
        assert.ok(saw, `case 7: action "${action}" dispatched to "${name}"`);
    }

    // Case 8: unknown action logs warning, returns 200 (best-effort).
    const beforeWarn = log.messages.length;
    const unk = await postJson("127.0.0.1", port, "/api/action",
        { action: "explode" }, { "x-token": token });
    assert.equal(unk.status, 200, "case 8: unknown action still returns 200");
    const sawWarn = await pollUntil(() =>
        log.messages.slice(beforeWarn).some((l) => /unknown action/.test(l.msg)));
    assert.ok(sawWarn, "case 8: warning logged for unknown action");

    // Case 9: returning to idle stops the server.
    await sidecar.syncVisibility({ enabled: true, status: "idle" });
    // stop() includes a 150ms grace for the close frame.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(sidecar.isRunning, false, "case 9: idle takes server down");

    // Case 10: enabled=false also keeps server down.
    await sidecar.syncVisibility({ enabled: false, status: "armed", goal: "x", hardCap: 1 });
    assert.equal(sidecar.isRunning, false, "case 10: disabled keeps server down");

    await sidecar.shutdown();
    console.log("✓ test-sidecar: 12/12 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
