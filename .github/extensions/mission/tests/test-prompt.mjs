// Test: completion token detection accepts the renamed token and the legacy token.
// Run: node tests/test-prompt.mjs

import assert from "node:assert/strict";
import { buildContinuationPrompt, detectComplete } from "../prompt.mjs";

async function run() {
    const prompt = buildContinuationPrompt("finish the rename", 1);
    assert.match(prompt, /\[mission turn 1\]/, "prompt uses mission turn label");
    assert.match(prompt, /MISSION_COMPLETE:/, "prompt asks for new token");
    assert.doesNotMatch(prompt, /AUTOPILOT_COMPLETE:/, "prompt does not ask for legacy token");

    assert.equal(
        detectComplete("done\nMISSION_COMPLETE: renamed extension"),
        "renamed extension",
        "new completion token is detected",
    );
    assert.equal(
        detectComplete("done\nAUTOPILOT_COMPLETE: legacy resumed session"),
        "legacy resumed session",
        "legacy completion token is still detected",
    );
    assert.equal(
        detectComplete("The string MISSION_COMPLETE: is only discussed inline."),
        null,
        "inline token mention is ignored",
    );

    console.log("✓ test-prompt: 6/6 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
