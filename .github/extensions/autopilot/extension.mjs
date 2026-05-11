// Extension: autopilot
// Autonomous turn continuation toward a stated objective. Walking skeleton.
//
// Modules:
//   state.mjs       — pure state machine (no I/O)
//   prompt.mjs      — continuation prompt + AUTOPILOT_COMPLETE detection
//   persistence.mjs — autopilot.json load/save in session workspace
//   controller.mjs  — orchestrates lifecycle, owns mutations
//   commands.mjs    — slash command parser
//   extension.mjs   — this file: SDK wiring only
//
// Design notes:
//   - State is durable in <workspacePath>/autopilot.json. Survives /clear and
//     session resume. Requires infinite sessions (we fail loud otherwise).
//   - All mutations go through the controller so persistence stays consistent.
//   - session.idle.aborted is honored — if the user pressed Ctrl-C, we don't
//     fire a continuation against their will.
//   - Plan mode auto-pauses; never auto-resumes.

import { joinSession } from "@github/copilot-sdk/extension";
import { createController } from "./controller.mjs";
import { makeAutopilotCommand } from "./commands.mjs";
import { WorkspaceUnavailable } from "./persistence.mjs";
import { createSidecar } from "./sidecar.mjs";

// Late-bound controller reference: the command needs a controller, the
// controller needs the session, the session is what joinSession returns.
// We break the cycle by passing this holder to the command at config time
// and populating it after joinSession resolves.
const controllerRef = { get: () => controllerRef.value, value: null };

let logFn = (msg) => console.error("[autopilot pre-init]", msg);
const cmd = makeAutopilotCommand(controllerRef, (m, o) => logFn(m, o));

const session = await joinSession({ commands: [cmd] });
logFn = (m, o) => session.log(m, o);

if (!session.workspacePath) {
    // Skeptic FATAL #2: without workspacePath we cannot persist enabled/off,
    // and an "armed" objective could silently vanish. Fail loud rather than
    // pretend to work.
    const err = new WorkspaceUnavailable();
    await logFn(`autopilot: ${err.message}`, { level: "error" });
    throw err;
}

// Sidecar is built before the controller so we can pass its visibility
// callback in. controllerRef wiring above means the sidecar can call
// controller methods (pause/resume/clear/off) once init() resolves.
const sidecar = createSidecar({
    sessionId: session.id ?? "unknown",
    log: logFn,
    // Late-bound — sidecar's HTTP handler reads this lazily, so the
    // controllerRef isn't dereferenced until after init() populates it.
    controller: {
        pause:          (...a) => controllerRef.value.pause(...a),
        resume:         (...a) => controllerRef.value.resume(...a),
        clearObjective: (...a) => controllerRef.value.clearObjective(...a),
        turnOff:        (...a) => controllerRef.value.turnOff(...a),
        turnOn:         (...a) => controllerRef.value.turnOn(...a),
        get snapshot()  { return controllerRef.value?.snapshot ?? null; },
    },
});

const controller = createController({
    session,
    workspacePath: session.workspacePath,
    log: logFn,
    onStateChange: (state) => {
        sidecar.syncVisibility(state).catch((err) =>
            logFn(`autopilot: sidecar sync failed: ${err?.message ?? err}`, { level: "warning" }),
        );
    },
});
controllerRef.value = controller;
await controller.init();

session.on("session.idle", (event) => {
    // Ignore sub-agent idle events — only the main session's idleness matters.
    if (event.agentId) return;
    controller.onIdle(event.data).catch((err) =>
        logFn(`autopilot: onIdle failed: ${err?.message ?? err}`, { level: "error" }),
    );
});

session.on("session.mode_changed", (event) => {
    if (event.agentId) return;
    controller.onModeChanged(event.data).catch((err) =>
        logFn(`autopilot: onModeChanged failed: ${err?.message ?? err}`, { level: "error" }),
    );
});

session.on("assistant.message", (event) => {
    // Sub-agent messages must not trigger AUTOPILOT_COMPLETE detection.
    // Sub-agents may emit the token while quoting the prompt.
    if (event.agentId) return;
    controller.onAssistantMessage(event.data).catch((err) =>
        logFn(`autopilot: onAssistantMessage failed: ${err?.message ?? err}`, { level: "error" }),
    );
});

session.on("session.usage_info", (event) => {
    // Coarse context-window pressure for the sidecar. Sub-agent usage events
    // would over-count, so filter to the root agent.
    if (event.agentId) return;
    try { controller.onUsageInfo(event.data); } catch { /* advisory only */ }
});

session.on("assistant.usage", (event) => {
    if (event.agentId) return;
    controller.onAssistantUsage(event.data, event.timestamp);
});

session.on?.("session.end", () => {
    sidecar.shutdown().catch(() => {});
});

await logFn(`autopilot ready: ${controller.summary()}`, { ephemeral: true });
