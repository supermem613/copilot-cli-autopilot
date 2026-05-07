// Test: persistence — volatile fields (contextTokens, etc.) must NOT be saved.
// Run: node tests/test-persistence.mjs

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../persistence.mjs";

async function run() {
    const workspace = await fs.mkdtemp(join(tmpdir(), "autopilot-test-"));

    // Save a state with volatile fields populated.
    const stateWithVolatile = {
        schemaVersion: 1,
        enabled: true,
        status: "armed",
        goal: "test",
        hardCap: 5,
        remainingTurns: 4,
        continuationsFired: 1,
        inFlight: false,
        createdAt: "2026-01-01T00:00:00Z",
        lastFiredAt: null,
        completedAt: null,
        completeSummary: null,
        contextTokens: 12345,
        contextMaxTokens: 200000,
        contextUpdatedAt: "2026-01-01T00:00:01Z",
    };
    await saveState(workspace, stateWithVolatile);

    // Read raw file — volatile fields must not appear.
    const raw = await fs.readFile(join(workspace, "autopilot.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.contextTokens, undefined, "contextTokens must not be persisted");
    assert.equal(parsed.contextMaxTokens, undefined, "contextMaxTokens must not be persisted");
    assert.equal(parsed.contextUpdatedAt, undefined, "contextUpdatedAt must not be persisted");
    assert.equal(parsed.goal, "test", "non-volatile fields are preserved");

    // Load — volatile fields are present but null (so the controller has
    // a defined shape to work with).
    const loaded = await loadState(workspace);
    assert.equal(loaded.contextTokens, null, "loaded contextTokens is null");
    assert.equal(loaded.contextMaxTokens, null, "loaded contextMaxTokens is null");
    assert.equal(loaded.contextUpdatedAt, null, "loaded contextUpdatedAt is null");
    assert.equal(loaded.goal, "test", "non-volatile fields round-trip");

    // Even if a malformed save has volatile fields written (older version),
    // loadState must scrub them.
    await fs.writeFile(
        join(workspace, "autopilot.json"),
        JSON.stringify({ ...stateWithVolatile, contextTokens: 999 }),
        "utf8",
    );
    const loaded2 = await loadState(workspace);
    assert.equal(loaded2.contextTokens, null, "load scrubs volatile fields from disk");

    await fs.rm(workspace, { recursive: true, force: true });
    console.log("✓ test-persistence: 6/6 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
