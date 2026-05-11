// Test: --cap argument parsing regressions.
// Run: node tests/test-cap-parsing.mjs
//
// Validates 9 cases including a regression guard for the bug where
// `--cap abc <goal>` silently fell through and was treated as the goal text.

import assert from "node:assert/strict";
import { makeMissionCommand } from "../commands.mjs";

const MAX_HARD_CAP = 100;

function makeFakes() {
    const logs = [];
    const calls = [];
    const fakeController = {
        async start(goal, opts) { calls.push({ method: "start", goal, opts }); },
        async pause() { calls.push({ method: "pause" }); },
        async resume() { calls.push({ method: "resume" }); },
        async clearObjective() { calls.push({ method: "clearObjective" }); },
        async turnOff() { calls.push({ method: "turnOff" }); },
        async turnOn() { calls.push({ method: "turnOn" }); },
        async show() { calls.push({ method: "show" }); },
    };
    const ref = { value: fakeController, get() { return fakeController; } };
    const log = async (msg, opts) => { logs.push({ msg, opts }); };
    const cmd = makeMissionCommand(ref, log);
    return { cmd, logs, calls };
}

async function run() {
    // 1. plain start
    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission start finish the report" });
        assert.equal(calls.length, 1, "case 1: should call controller once");
        assert.equal(calls[0].method, "start");
        assert.equal(calls[0].goal, "finish the report");
        assert.deepEqual(calls[0].opts, {}, "case 1: no opts");
    }

    // 2. --cap N
    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission start --cap 5 finish the report" });
        assert.equal(calls.length, 1, "case 2: should call controller");
        assert.equal(calls[0].goal, "finish the report");
        assert.equal(calls[0].opts.hardCap, 5, "case 2: cap=5");
    }

    // 3. --cap=N
    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission start --cap=7 finish the report" });
        assert.equal(calls.length, 1, "case 3: should call controller");
        assert.equal(calls[0].goal, "finish the report");
        assert.equal(calls[0].opts.hardCap, 7, "case 3: cap=7");
    }

    // 4. --cap abc <goal> — REGRESSION GUARD
    // Before the fix: regex required digits, so the malformed flag fell
    // through and was treated as part of the goal text.
    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission start --cap abc finish the report" });
        assert.equal(calls.length, 0, "case 4: must NOT arm with malformed --cap");
        const warnedAboutCap = logs.some((l) => /--cap/.test(l.msg) && l.opts?.level === "warning");
        assert.ok(warnedAboutCap, "case 4: should log a warning about --cap");
    }

    // 5. --cap 9999 → clamp to MAX_HARD_CAP
    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission start --cap 9999 finish the report" });
        assert.equal(calls.length, 1, "case 5: should still arm (with clamp)");
        assert.equal(calls[0].opts.hardCap, MAX_HARD_CAP, "case 5: clamped to MAX_HARD_CAP");
        const warnedAboutClamp = logs.some((l) => /clamp/i.test(l.msg));
        assert.ok(warnedAboutClamp, "case 5: should log a clamp warning");
    }

    // 6. --cap 0 → reject (positive integer required)
    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission start --cap 0 finish the report" });
        assert.equal(calls.length, 0, "case 6: cap=0 must reject");
        assert.ok(logs.some((l) => /positive integer/.test(l.msg)),
            "case 6: should log positive-integer warning");
    }

    // 7. --cap 1.5 → reject (not an integer; "1.5" !== String(parseInt("1.5")))
    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission start --cap 1.5 finish the report" });
        assert.equal(calls.length, 0, "case 7: cap=1.5 must reject");
    }

    // 8. start with no objective at all
    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission start" });
        assert.equal(calls.length, 0, "case 8: empty start must not arm");
        assert.ok(logs.some((l) => /missing objective/i.test(l.msg)),
            "case 8: should warn about missing objective");
    }

    // 9. start --cap 5 with no objective after the cap
    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission start --cap 5" });
        assert.equal(calls.length, 0, "case 9: --cap with no objective must reject");
        assert.ok(logs.some((l) => /--cap/.test(l.msg) && l.opts?.level === "warning"),
            "case 9: should warn");
    }

    console.log(`✓ test-cap-parsing: 9/9 passed`);
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
