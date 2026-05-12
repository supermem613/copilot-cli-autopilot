// Test: persistence — token counters survive restart while context pressure stays volatile.
// Run: node tests/test-persistence.mjs

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../persistence.mjs";

async function run() {
    const workspace = await fs.mkdtemp(join(tmpdir(), "mission-test-"));

    // Save a state with volatile fields populated.
    const stateWithVolatile = {
        schemaVersion: 1,
        enabled: true,
        status: "armed",
        goal: "test",
        continuationsFired: 1,
        inFlight: false,
        createdAt: "2026-01-01T00:00:00Z",
        lastFiredAt: null,
        completedAt: null,
        completeSummary: null,
        contextTokens: 12345,
        contextMaxTokens: 200000,
        contextUpdatedAt: "2026-01-01T00:00:01Z",
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 200,
        cacheWriteTokens: 3,
        reasoningTokens: 7,
        tokenUpdatedAt: "2026-01-01T00:00:02Z",
    };
    await saveState(workspace, stateWithVolatile);

    // Read raw file — context fields must not appear, objective token counters must.
    const raw = await fs.readFile(join(workspace, "mission.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.contextTokens, undefined, "contextTokens must not be persisted");
    assert.equal(parsed.contextMaxTokens, undefined, "contextMaxTokens must not be persisted");
    assert.equal(parsed.contextUpdatedAt, undefined, "contextUpdatedAt must not be persisted");
    assert.equal(parsed.inputTokens, 100, "inputTokens must be persisted");
    assert.equal(parsed.outputTokens, 25, "outputTokens must be persisted");
    assert.equal(parsed.cacheReadTokens, 200, "cacheReadTokens must be persisted");
    assert.equal(parsed.cacheWriteTokens, 3, "cacheWriteTokens must be persisted");
    assert.equal(parsed.reasoningTokens, 7, "reasoningTokens must be persisted");
    assert.equal(parsed.tokenUpdatedAt, "2026-01-01T00:00:02Z", "tokenUpdatedAt must be persisted");
    assert.equal(parsed.goal, "test", "non-volatile fields are preserved");
    assert.equal(parsed.hardCap, undefined, "legacy hardCap must not be persisted");
    assert.equal(parsed.remainingTurns, undefined, "legacy remainingTurns must not be persisted");

    // Load — context fields are null, token counters round-trip.
    const loaded = await loadState(workspace);
    assert.equal(loaded.contextTokens, null, "loaded contextTokens is null");
    assert.equal(loaded.contextMaxTokens, null, "loaded contextMaxTokens is null");
    assert.equal(loaded.contextUpdatedAt, null, "loaded contextUpdatedAt is null");
    assert.equal(loaded.inputTokens, 100, "loaded inputTokens round-trips");
    assert.equal(loaded.outputTokens, 25, "loaded outputTokens round-trips");
    assert.equal(loaded.tokenUpdatedAt, "2026-01-01T00:00:02Z", "loaded tokenUpdatedAt round-trips");
    assert.equal(loaded.goal, "test", "non-volatile fields round-trip");

    // Even if a malformed save has context fields written (older version),
    // loadState must scrub them without losing token totals.
    await fs.writeFile(
        join(workspace, "mission.json"),
        JSON.stringify({
            ...stateWithVolatile,
            contextTokens: 999,
            inputTokens: 999,
            hardCap: 5,
            remainingTurns: 4,
        }),
        "utf8",
    );
    const loaded2 = await loadState(workspace);
    assert.equal(loaded2.contextTokens, null, "load scrubs context fields from disk");
    assert.equal(loaded2.inputTokens, 999, "load preserves token counters from disk");
    assert.equal(loaded2.hardCap, undefined, "load scrubs legacy hardCap from disk");
    assert.equal(loaded2.remainingTurns, undefined, "load scrubs legacy remainingTurns from disk");

    await fs.writeFile(
        join(workspace, "mission.json"),
        JSON.stringify({
            ...stateWithVolatile,
            enabled: false,
            status: "armed",
            goal: "legacy disabled mission",
        }),
        "utf8",
    );
    const legacyDisabled = await loadState(workspace);
    assert.equal(legacyDisabled.enabled, true, "load re-enables legacy disabled state");
    assert.equal(legacyDisabled.status, "armed", "legacy disabled active mission remains armed");
    assert.equal(legacyDisabled.goal, "legacy disabled mission", "legacy disabled objective is preserved");

    await fs.rm(join(workspace, "mission.json"), { force: true });
    await fs.writeFile(join(workspace, "autopilot.json"), JSON.stringify(stateWithVolatile), "utf8");
    const migrated = await loadState(workspace);
    assert.equal(migrated.goal, "test", "legacy autopilot.json migrates");
    await assert.doesNotReject(() => fs.access(join(workspace, "mission.json")), "migration writes mission.json");
    await assert.rejects(() => fs.access(join(workspace, "autopilot.json")), "migration removes autopilot.json");

    await fs.rm(workspace, { recursive: true, force: true });
    console.log("✓ test-persistence: 28/28 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
