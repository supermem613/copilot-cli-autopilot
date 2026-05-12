// Test: controller shutdown drains scheduled kickoff work before workspace cleanup.
// Run: node tests/test-controller-shutdown.mjs

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function pollUntil(fn, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

async function run() {
    {
        const workspace = await mkdtemp(join(tmpdir(), "mission-restore-"));
        const session = makeSession();
        await writeFile(join(workspace, "mission.json"), JSON.stringify({
            schemaVersion: 1,
            enabled: true,
            status: "armed",
            goal: "resume after restart",
            continuationsFired: 2,
            inFlight: false,
            createdAt: new Date().toISOString(),
            lastFiredAt: null,
            completedAt: null,
            completeSummary: null,
            inputTokens: 1234,
            outputTokens: 567,
            tokenUpdatedAt: "2026-01-01T00:00:00Z",
        }), "utf8");
        const states = [];
        const controller = createController({
            session,
            workspacePath: workspace,
            log: async () => {},
            onStateChange: (state) => states.push(state),
        });

        await controller.init();
        if (states[0]?.inputTokens !== 1234 || states[0]?.outputTokens !== 567) {
            throw new Error("expected restored token totals to notify before restore kickoff");
        }
        const restoredKickedOff = await pollUntil(() => controller.snapshot.inFlight);
        if (!restoredKickedOff) {
            throw new Error("expected restored armed mission to reserve a continuation after init");
        }

        await controller.shutdown();
        await rm(workspace, { recursive: true, force: true });
    }

    {
        const workspace = await mkdtemp(join(tmpdir(), "mission-show-"));
        const shown = [];
        const controller = createController({
            session: makeSession(),
            workspacePath: workspace,
            log: async () => {},
            onStateChange: () => {},
            onShow: (state) => shown.push(state),
        });

        await controller.init();
        await controller.start("visible objective");
        await controller.pause();
        await controller.resume();

        const shownStatuses = shown.map((state) => state.status);
        if (shownStatuses.join(",") !== "armed,armed") {
            throw new Error(`expected start and resume to show armed UX, got ${shownStatuses.join(",")}`);
        }
        const resumeKickedOff = await pollUntil(() => controller.snapshot.inFlight);
        if (!resumeKickedOff) {
            throw new Error("expected resume to reserve a continuation immediately");
        }

        await controller.shutdown();
        await rm(workspace, { recursive: true, force: true });
    }

    {
        const workspace = await mkdtemp(join(tmpdir(), "mission-blocked-"));
        const logs = [];
        const session = makeSession();
        const controller = createController({
            session,
            workspacePath: workspace,
            log: async (msg) => { logs.push(msg); },
            onStateChange: () => {},
        });

        await controller.init();
        await controller.start("finish blocked work");
        await controller.onAssistantMessage({
            content: "I cannot proceed.\nMISSION_BLOCKED: missing credentials",
        });
        await new Promise((resolve) => setImmediate(resolve));

        if (controller.snapshot.status !== "blocked") {
            throw new Error(`expected blocked status, got ${controller.snapshot.status}`);
        }
        if (session.sent.length !== 0) {
            throw new Error("blocked mission must not send another continuation");
        }
        if (!logs.some((msg) => /mission BLOCKED: missing credentials/.test(msg))) {
            throw new Error("expected blocked log message");
        }

        await controller.shutdown();
        await rm(workspace, { recursive: true, force: true });
    }

    for (let i = 0; i < 50; i += 1) {
        const workspace = await mkdtemp(join(tmpdir(), "mission-shutdown-"));
        const controller = createController({
            session: makeSession(),
            workspacePath: workspace,
            log: async () => {},
            onStateChange: () => {},
        });

        await controller.init();
        await controller.start("first objective");
        await controller.start("replacement objective");
        await controller.shutdown();
        await rm(workspace, { recursive: true, force: true });
    }

    console.log("✓ test-controller-shutdown: 1/1 passed");
}

run().catch((err) => { console.error("FAIL:", err); process.exit(1); });
