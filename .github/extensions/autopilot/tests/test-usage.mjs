// Test: assistant.usage token counters are volatile and per-objective.
// Run: node tests/test-usage.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createController } from "../controller.mjs";

function makeSession() {
    return {
        sent: [],
        capabilities: {},
        send(payload) { this.sent.push(payload); },
    };
}

async function run() {
    const workspace = await mkdtemp(join(tmpdir(), "autopilot-usage-"));
    const logs = [];
    const states = [];
    const session = makeSession();
    const controller = createController({
        session,
        workspacePath: workspace,
        log: async (msg, opts) => logs.push({ msg, opts }),
        onStateChange: (state) => states.push(state),
    });

    await controller.init();
    controller.onAssistantUsage({ inputTokens: 10, outputTokens: 5 }, "2026-01-01T00:00:00Z");
    assert.equal(controller.snapshot.inputTokens, 0, "idle usage is ignored");

    await controller.start("ship token accounting", { hardCap: 3 });
    controller.onAssistantUsage({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 200,
        cacheWriteTokens: 3,
        reasoningTokens: 7,
    }, "2026-01-01T00:00:01Z");
    controller.onAssistantUsage({ inputTokens: 50, outputTokens: 10 }, "2026-01-01T00:00:02Z");

    assert.equal(controller.snapshot.inputTokens, 150, "input tokens accumulate");
    assert.equal(controller.snapshot.outputTokens, 35, "output tokens accumulate");
    assert.equal(controller.snapshot.cacheReadTokens, 200, "cache read tokens accumulate");
    assert.equal(controller.snapshot.cacheWriteTokens, 3, "cache write tokens accumulate");
    assert.equal(controller.snapshot.reasoningTokens, 7, "reasoning tokens accumulate");
    assert.equal(controller.snapshot.tokenUpdatedAt, "2026-01-01T00:00:02Z", "last token timestamp wins");

    await controller.start("new objective", { hardCap: 2 });
    assert.equal(controller.snapshot.inputTokens, 0, "new objective resets input tokens");
    assert.equal(controller.snapshot.outputTokens, 0, "new objective resets output tokens");
    assert.ok(states.some((s) => s.inputTokens === 150), "usage updates notify sidecar");

    await controller.shutdown();
    await rm(workspace, { recursive: true, force: true });
    console.log("✓ test-usage: 8/8 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
