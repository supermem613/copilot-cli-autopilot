// Test: assistant.usage token counters are durable and per-objective.
// Run: node tests/test-usage.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createController } from "../controller.mjs";
import { loadState } from "../persistence.mjs";

function makeSession() {
    return {
        sent: [],
        capabilities: {},
        send(payload) { this.sent.push(payload); },
    };
}

async function run() {
    const workspace = await mkdtemp(join(tmpdir(), "mission-usage-"));
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

    await controller.start("ship token accounting");
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
    await controller.shutdown();

    const restored = await loadState(workspace);
    assert.equal(restored.inputTokens, 150, "input tokens persist for restart");
    assert.equal(restored.outputTokens, 35, "output tokens persist for restart");

    const controller2 = createController({
        session,
        workspacePath: workspace,
        log: async (msg, opts) => logs.push({ msg, opts }),
        onStateChange: (state) => states.push(state),
    });
    await controller2.init();
    assert.equal(controller2.snapshot.inputTokens, 150, "restart restores input tokens before kickoff");
    assert.equal(controller2.snapshot.outputTokens, 35, "restart restores output tokens before kickoff");

    await controller2.start("new objective");
    assert.equal(controller2.snapshot.inputTokens, 0, "new objective resets input tokens");
    assert.equal(controller2.snapshot.outputTokens, 0, "new objective resets output tokens");
    assert.ok(states.some((s) => s.inputTokens === 150), "usage updates notify sidecar");

    await controller2.shutdown();
    await rm(workspace, { recursive: true, force: true });
    console.log("✓ test-usage: 12/12 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
