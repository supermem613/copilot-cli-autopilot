// Pure state machine. No I/O, no SDK references. Easy to unit test mentally.
// State invariants are enforced here so the controller stays thin.

export const SCHEMA_VERSION = 1;
export const DEFAULT_HARD_CAP = 20;

// status values:
//   idle      — no objective armed
//   armed     — objective active, continuations will fire on session.idle
//   paused    — objective active, continuations suppressed until resume
//   spent     — turn cap exhausted; needs new /autopilot start to re-arm
//   complete  — agent emitted AUTOPILOT_COMPLETE: terminator
export const STATUSES = ["idle", "armed", "paused", "spent", "complete"];

export function makeDefaultState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        enabled: true,
        status: "idle",
        goal: null,
        hardCap: DEFAULT_HARD_CAP,
        remainingTurns: 0,
        continuationsFired: 0,
        inFlight: false,
        createdAt: null,
        lastFiredAt: null,
        completedAt: null,
        completeSummary: null,
        // Coarse context-window tracking. Updated on session.usage_info events.
        // currentTokens is what the SDK calls "context window state" (not spend).
        contextTokens: null,
        contextMaxTokens: null,
        contextUpdatedAt: null,
    };
}

// Coerce an unknown blob into a valid state. Used when loading persisted JSON
// that may be from a different schema version or partially corrupted. We never
// crash on bad persisted data — we degrade to defaults, because failing to
// start the extension is worse than losing a stale objective.
export function normalizeState(raw) {
    const d = makeDefaultState();
    if (!raw || typeof raw !== "object") return d;
    if (raw.schemaVersion !== SCHEMA_VERSION) return d;
    return {
        ...d,
        ...raw,
        // Force inFlight false on load — process restart invalidates any in-flight send.
        inFlight: false,
        // Validate enums.
        status: STATUSES.includes(raw.status) ? raw.status : "idle",
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
        hardCap: Number.isInteger(raw.hardCap) && raw.hardCap > 0 ? raw.hardCap : DEFAULT_HARD_CAP,
        remainingTurns: Number.isInteger(raw.remainingTurns) ? Math.max(0, raw.remainingTurns) : 0,
        continuationsFired: Number.isInteger(raw.continuationsFired) ? raw.continuationsFired : 0,
    };
}

// Returns a NEW state object (immutable update style — easier to reason about).

export function arm(state, goal, hardCap = DEFAULT_HARD_CAP) {
    const now = new Date().toISOString();
    return {
        ...state,
        status: "armed",
        goal,
        hardCap,
        remainingTurns: hardCap,
        continuationsFired: 0,
        inFlight: false,
        createdAt: now,
        lastFiredAt: null,
        completedAt: null,
        completeSummary: null,
    };
}

export function pause(state) {
    if (state.status !== "armed") return state;
    return { ...state, status: "paused" };
}

export function resume(state) {
    if (state.status !== "paused") return state;
    return { ...state, status: "armed" };
}

export function clear(state) {
    return {
        ...state,
        status: "idle",
        goal: null,
        remainingTurns: 0,
        inFlight: false,
        createdAt: null,
        lastFiredAt: null,
        completedAt: null,
        completeSummary: null,
    };
}

export function disable(state) {
    return { ...clear(state), enabled: false };
}

export function enable(state) {
    return { ...state, enabled: true };
}

export function markFiring(state) {
    return {
        ...state,
        inFlight: true,
        remainingTurns: Math.max(0, state.remainingTurns - 1),
        continuationsFired: state.continuationsFired + 1,
        lastFiredAt: new Date().toISOString(),
    };
}

export function markFireSettled(state) {
    const next = { ...state, inFlight: false };
    if (next.status === "armed" && next.remainingTurns <= 0) next.status = "spent";
    return next;
}

export function markComplete(state, summary) {
    return {
        ...state,
        status: "complete",
        inFlight: false,
        completedAt: new Date().toISOString(),
        completeSummary: summary,
    };
}

// Decision predicate. Pure: given the current state and an idle event payload,
// should the controller fire a continuation right now?
// Returns { fire: boolean, reason: string } so the controller can log either way.
export function shouldFire(state, idleData) {
    if (!state.enabled) return { fire: false, reason: "disabled" };
    if (state.status !== "armed") return { fire: false, reason: `status=${state.status}` };
    if (state.inFlight) return { fire: false, reason: "already in flight" };
    if (idleData?.aborted) return { fire: false, reason: "previous turn was aborted" };
    if (state.remainingTurns <= 0) return { fire: false, reason: "turn cap reached" };
    return { fire: true, reason: "armed and ready" };
}

// Format a one-line summary for /autopilot show and the spike status command.
export function summarize(state) {
    if (!state.enabled) return "autopilot DISABLED (/autopilot on to re-enable)";
    if (state.status === "idle") return "autopilot idle (no objective)";
    if (state.status === "complete") {
        return `autopilot COMPLETE: ${state.completeSummary ?? "(no summary)"} ` +
            `[fired ${state.continuationsFired}/${state.hardCap}]`;
    }
    return `autopilot ${state.status.toUpperCase()}: "${state.goal}" ` +
        `[${state.continuationsFired}/${state.hardCap} fired, ${state.remainingTurns} remaining]`;
}
