// Extension: mission
// Autonomous turn continuation toward a stated objective. Walking skeleton.
//
// Modules:
//   state.mjs       — pure state machine (no I/O)
//   prompt.mjs      — continuation prompt + MISSION_COMPLETE detection
//   persistence.mjs — mission.json load/save in session workspace
//   controller.mjs  — orchestrates lifecycle, owns mutations
//   commands.mjs    — slash command parser
//   extension.mjs   — this file: SDK wiring only
//
// Design notes:
//   - State is durable in <workspacePath>/mission.json. Survives /clear and
//     session resume. Requires infinite sessions (we fail loud otherwise).
//   - All mutations go through the controller so persistence stays consistent.
//   - session.idle.aborted is honored — if the user pressed Ctrl-C, we don't
//     fire a continuation against their will.
//   - Plan mode auto-pauses; never auto-resumes.

import { joinSession } from "@github/copilot-sdk/extension";
import { createController } from "./controller.mjs";
import { makeMissionCommand } from "./commands.mjs";
import { WorkspaceUnavailable } from "./persistence.mjs";
import { createSidecar } from "./sidecar.mjs";

// Late-bound controller reference: the command needs a controller, the
// controller needs the session, the session is what joinSession returns.
// We break the cycle by passing this holder to the command at config time
// and populating it after joinSession resolves.
const controllerRef = { get: () => controllerRef.value, value: null };

let logFn = (msg) => console.error("[mission pre-init]", msg);
const cmd = makeMissionCommand(controllerRef, (m, o) => logFn(m, o));

const session = await joinSession({ commands: [cmd] });
logFn = (m, o) => session.log(m, o);

if (!session.workspacePath) {
    // Skeptic FATAL #2: without workspacePath we cannot persist state,
    // and an "armed" objective could silently vanish. Fail loud rather than
    // pretend to work.
    const err = new WorkspaceUnavailable();
    await logFn(`mission: ${err.message}`, { level: "error" });
    throw err;
}

// Sidecar is built before the controller so we can pass its visibility
// callback in. controllerRef wiring above means the sidecar can call
// controller methods once init() resolves.
const sidecar = createSidecar({
    sessionId: session.id ?? "unknown",
    log: logFn,
    // Late-bound — sidecar's HTTP handler reads this lazily, so the
    // controllerRef isn't dereferenced until after init() populates it.
    controller: {
        pause:          (...a) => controllerRef.value.pause(...a),
        resume:         (...a) => controllerRef.value.resume(...a),
        clearObjective: (...a) => controllerRef.value.clearObjective(...a),
        start:          (...a) => controllerRef.value.start(...a),
        get snapshot()  { return controllerRef.value?.snapshot ?? null; },
    },
});

const controller = createController({
    session,
    workspacePath: session.workspacePath,
    log: logFn,
    onStateChange: (state) => {
        sidecar.syncVisibility(state).catch((err) =>
            logFn(`mission: sidecar sync failed: ${err?.message ?? err}`, { level: "warning" }),
        );
    },
    onShow: (state) => sidecar.show(state),
});
controllerRef.value = controller;
await controller.init();

session.on("session.idle", (event) => {
    // Ignore sub-agent idle events — only the main session's idleness matters.
    if (event.agentId) return;
    controller.onIdle(event.data).catch((err) =>
        logFn(`mission: onIdle failed: ${err?.message ?? err}`, { level: "error" }),
    );
});

session.on("session.mode_changed", (event) => {
    if (event.agentId) return;
    controller.onModeChanged(event.data).catch((err) =>
        logFn(`mission: onModeChanged failed: ${err?.message ?? err}`, { level: "error" }),
    );
});

session.on("assistant.message", (event) => {
    // Sub-agent messages must not trigger MISSION_COMPLETE detection.
    // Sub-agents may emit the token while quoting the prompt.
    if (event.agentId) return;
    controller.onAssistantMessage(event.data).catch((err) =>
        logFn(`mission: onAssistantMessage failed: ${err?.message ?? err}`, { level: "error" }),
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
    controller.shutdown().catch(() => {});
    sidecar.shutdown().catch(() => {});
});
