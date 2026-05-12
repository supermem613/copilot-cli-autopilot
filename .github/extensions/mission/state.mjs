// Pure state machine. No I/O, no SDK references. Easy to unit test mentally.
// State invariants are enforced here so the controller stays thin.

export const SCHEMA_VERSION = 1;

// status values:
//   idle      — no objective armed
//   armed     — objective active, continuations will fire on session.idle
//   paused    — objective active, continuations suppressed until resume
//   complete  — agent emitted MISSION_COMPLETE: terminator
export const STATUSES = ["idle", "armed", "paused", "complete"];

export function makeDefaultState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        enabled: true,
        status: "idle",
        goal: null,
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
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        tokenUpdatedAt: null,
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
        status: normalizeStatus(raw.status, raw.goal),
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
        continuationsFired: Number.isInteger(raw.continuationsFired) ? raw.continuationsFired : 0,
        inputTokens: normalizeTokenCounter(raw.inputTokens),
        outputTokens: normalizeTokenCounter(raw.outputTokens),
        cacheReadTokens: normalizeTokenCounter(raw.cacheReadTokens),
        cacheWriteTokens: normalizeTokenCounter(raw.cacheWriteTokens),
        reasoningTokens: normalizeTokenCounter(raw.reasoningTokens),
        tokenUpdatedAt: typeof raw.tokenUpdatedAt === "string" ? raw.tokenUpdatedAt : null,
    };
}

function normalizeTokenCounter(value) {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeStatus(status, goal) {
    if (STATUSES.includes(status)) return status;
    if (status === "spent" && goal) return "armed";
    return "idle";
}

// Returns a NEW state object (immutable update style — easier to reason about).

export function arm(state, goal) {
    const now = new Date().toISOString();
    return {
        ...state,
        status: "armed",
        goal,
        continuationsFired: 0,
        inFlight: false,
        createdAt: now,
        lastFiredAt: null,
        completedAt: null,
        completeSummary: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        tokenUpdatedAt: null,
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
        continuationsFired: state.continuationsFired + 1,
        lastFiredAt: new Date().toISOString(),
    };
}

export function markFireSettled(state) {
    return { ...state, inFlight: false };
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
    return { fire: true, reason: "armed and ready" };
}

// Format a one-line summary for /mission and the sidecar.
export function summarize(state) {
    if (!state.enabled) return "mission DISABLED (/mission on to re-enable)";
    if (state.status === "idle") return "mission idle (no objective)";
    if (state.status === "complete") {
        return `mission COMPLETE: ${state.completeSummary ?? "(no summary)"} ` +
            `[${state.continuationsFired} turns]`;
    }
    return `mission ${state.status.toUpperCase()}: "${state.goal}" ` +
        `[${state.continuationsFired} turns]`;
}
