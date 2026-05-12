// Test: mission command parsing regressions.
// Run: node tests/test-command-parsing.mjs

import assert from "node:assert/strict";
import { makeMissionCommand } from "../commands.mjs";

function makeFakes() {
    const logs = [];
    const calls = [];
    const fakeController = {
        async start(goal) { calls.push({ method: "start", goal }); },
        async pause() { calls.push({ method: "pause" }); },
        async resume() { calls.push({ method: "resume" }); },
        async clearObjective() { calls.push({ method: "clearObjective" }); },
        async show() { calls.push({ method: "show" }); },
    };
    const ref = { get() { return fakeController; } };
    const log = async (msg, opts) => { logs.push({ msg, opts }); };
    const cmd = makeMissionCommand(ref, log);
    return { cmd, logs, calls };
}

async function run() {
    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission finish the report" });
        assert.deepEqual(
            calls,
            [{ method: "start", goal: "finish the report" }],
            "plain objective dispatches start",
        );
    }

    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission start finish the report" });
        assert.deepEqual(
            calls,
            [{ method: "start", goal: "finish the report" }],
            "legacy start syntax still dispatches objective",
        );
    }

    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission start --cap 5 finish the report" });
        assert.equal(calls.length, 0, "removed --cap flag must not arm");
        assert.ok(
            logs.some((l) => /--cap is no longer supported/.test(l.msg) && l.opts?.level === "warning"),
            "removed legacy --cap flag logs a warning",
        );
    }

    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission --cap 5 finish the report" });
        assert.equal(calls.length, 0, "removed --cap objective prefix must not arm");
        assert.ok(
            logs.some((l) => /--cap is no longer supported/.test(l.msg) && l.opts?.level === "warning"),
            "removed --cap objective prefix logs a warning",
        );
    }

    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission --cap=5 finish the report" });
        assert.equal(calls.length, 0, "removed --cap= flag must not arm");
        assert.ok(
            logs.some((l) => /--cap is no longer supported/.test(l.msg) && l.opts?.level === "warning"),
            "removed --cap= flag logs a warning",
        );
    }

    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission start" });
        assert.deepEqual(calls, [{ method: "start", goal: "start" }], "start can be an objective");
    }

    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission" });
        assert.deepEqual(calls, [{ method: "show" }], "bare mission defaults to show");
    }

    {
        const { cmd, calls } = makeFakes();
        await cmd.handler({ command: "/mission pause" });
        await cmd.handler({ command: "/mission resume" });
        await cmd.handler({ command: "/mission clear" });
        assert.deepEqual(
            calls,
            [{ method: "pause" }, { method: "resume" }, { method: "clearObjective" }],
            "control verbs dispatch",
        );
    }

    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission help" });
        assert.ok(
            logs.some((l) => /retry a blocked mission/.test(l.msg)),
            "help documents blocked mission resume",
        );
        assert.ok(
            !logs.some((l) => /\/mission off/.test(l.msg) || /\/mission on/.test(l.msg)),
            "help does not document removed off/on commands",
        );
        assert.equal(calls.length, 0, "help does not dispatch controller calls");
    }

    {
        const { cmd, calls, logs } = makeFakes();
        await cmd.handler({ command: "/mission off" });
        await cmd.handler({ command: "/mission on" });
        assert.deepEqual(calls, [], "removed off/on commands do not dispatch");
        assert.ok(
            logs.some((l) => /\/mission off was removed/.test(l.msg) && l.opts?.level === "warning"),
            "removed off command logs warning",
        );
        assert.ok(
            logs.some((l) => /\/mission on was removed/.test(l.msg) && l.opts?.level === "warning"),
            "removed on command logs warning",
        );
    }

    console.log("✓ test-command-parsing: 10/10 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
