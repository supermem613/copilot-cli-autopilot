// Test: controller shutdown drains scheduled kickoff work before workspace cleanup.
// Run: node tests/test-controller-shutdown.mjs

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
    for (let i = 0; i < 50; i += 1) {
        const workspace = await mkdtemp(join(tmpdir(), "autopilot-shutdown-"));
        const controller = createController({
            session: makeSession(),
            workspacePath: workspace,
            log: async () => {},
            onStateChange: () => {},
        });

        await controller.init();
        await controller.start("first objective", { hardCap: 3 });
        await controller.start("replacement objective", { hardCap: 2 });
        await controller.shutdown();
        await rm(workspace, { recursive: true, force: true });
    }

    console.log("✓ test-controller-shutdown: 1/1 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
