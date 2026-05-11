// Lifecycle controller. Owns the in-memory state and is the only place that
// mutates it. Exposes high-level operations (start, pause, resume, ...) that
// commands.mjs and the event handlers in extension.mjs call.
//
// Invariants (enforced here so commands.mjs stays declarative):
//   - Every mutation that changes persisted fields calls saveState before returning.
//   - All session.send() calls are deferred via setTimeout(0) to avoid reentrancy
//     with the idle event that triggered them.
//   - The grace window between "idle observed" and "send fired" gives the user
//     a chance to cancel via /autopilot off|pause|clear without burning a turn.

import {
    arm, pause, resume, clear, disable, enable,
    markFiring, markFireSettled, markComplete,
    shouldFire, summarize,
} from "./state.mjs";
import { loadState, saveState } from "./persistence.mjs";
import { buildContinuationPrompt, detectComplete } from "./prompt.mjs";

export const GRACE_MS = 1500;

export function createController({ session, workspacePath, log, onStateChange }) {
    let state;
    // Serialize state writes so two near-simultaneous mutations cannot tear each
    // other (atomic rename helps within a single write, but two concurrent
    // writes could still race on the rename target). Errors propagate to the
    // caller so a failed disk write fails the user-visible operation
    // (Shadow review #3 — durable-state contract).
    let writeQueue = Promise.resolve();
    function persist() {
        const snapshot = state;
        const next = writeQueue.then(() => saveState(workspacePath, snapshot));
        writeQueue = next.catch(() => {});
        return next;
    }

    // Fire-and-forget notification to the sidecar (or any listener). Errors
    // here are advisory only — they must NOT roll back a successful commit.
    function notify() {
        if (!onStateChange) return;
        Promise.resolve().then(() => onStateChange({ ...state })).catch((err) => {
            log(`autopilot: state notify failed: ${err?.message ?? err}`, { level: "warning" })
                .catch(() => {});
        });
    }

    // Wrap a mutation so a failed disk write rolls back the in-memory state and
    // surfaces the error to the user. Without this, a write failure would leave
    // RAM and disk inconsistent and the user would see a success log.
    async function commit(prevState, nextState, label) {
        state = nextState;
        try {
            await persist();
        } catch (err) {
            state = prevState;
            await log(`autopilot: ${label} failed (disk write): ${err?.message ?? err}. Reverted.`,
                { level: "error" });
            notify();
            throw err;
        }
        notify();
    }

    return {
        async init() {
            state = await loadState(workspacePath);
            await log(
                `autopilot loaded: ${summarize(state)} (workspace: ${workspacePath})`,
                { ephemeral: true },
            );
            notify();
        },

        get snapshot() { return { ...state }; },

        summary() { return summarize(state); },

        // Coarse context-window tracking. Updated on session.usage_info.
        // In-memory only — not worth a disk write per tick. The next idle/start
        // commit will incidentally persist whatever is current.
        onUsageInfo(data) {
            const tokens = data?.currentTokens;
            const max = data?.maxTokens;
            if (typeof tokens !== "number") return;
            state = {
                ...state,
                contextTokens: tokens,
                contextMaxTokens: typeof max === "number" ? max : state.contextMaxTokens,
                contextUpdatedAt: new Date().toISOString(),
            };
            notify();
        },

        onAssistantUsage(data, timestamp) {
            if (!state.enabled || !state.goal || state.status === "idle") return;
            const inputTokens = tokenCount(data?.inputTokens);
            const outputTokens = tokenCount(data?.outputTokens);
            const cacheReadTokens = tokenCount(data?.cacheReadTokens);
            const cacheWriteTokens = tokenCount(data?.cacheWriteTokens);
            const reasoningTokens = tokenCount(data?.reasoningTokens);
            if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) return;
            state = {
                ...state,
                inputTokens: (state.inputTokens || 0) + inputTokens,
                outputTokens: (state.outputTokens || 0) + outputTokens,
                cacheReadTokens: (state.cacheReadTokens || 0) + cacheReadTokens,
                cacheWriteTokens: (state.cacheWriteTokens || 0) + cacheWriteTokens,
                reasoningTokens: (state.reasoningTokens || 0) + reasoningTokens,
                tokenUpdatedAt: timestamp || new Date().toISOString(),
            };
            notify();
        },

        async start(goal, opts = {}) {
            if (!state.enabled) {
                await log("autopilot is DISABLED. Run /autopilot on to re-enable.", { level: "warning" });
                return;
            }
            const wasActive = state.status === "armed" || state.status === "paused";
            // Replacement confirmation — capability-gated; if elicitation isn't
            // available we proceed (with a warning), preserving Codex parity
            // where /goal silently replaces the active objective.
            if (wasActive && session.capabilities?.ui?.elicitation) {
                const ok = await session.ui.confirm(
                    `Replace current autopilot objective?\n` +
                    `  current: "${state.goal}" (${state.continuationsFired}/${state.hardCap} fired)\n` +
                    `  new:     "${goal}"`
                );
                if (!ok) {
                    await log("autopilot: replacement declined; keeping current objective");
                    return;
                }
            } else if (wasActive) {
                await log(`autopilot: replacing active objective "${state.goal}"`, { level: "warning" });
            }
            const prev = state;
            const cap = Number.isInteger(opts.hardCap) && opts.hardCap > 0 ? opts.hardCap : prev.hardCap;
            await commit(prev, arm(state, goal, cap), "start");
            await log(
                `autopilot ARMED: "${goal}" [cap=${state.hardCap}, grace=${GRACE_MS}ms]. ` +
                `Will fire on next idle. /autopilot pause|off to stop.`,
            );
            // Kick off immediately — slash commands don't trigger session.idle on
            // their own, so without this the user would have to send a separate
            // prompt to start the loop. We synthesize an idle event with
            // aborted=false so the normal grace+recheck path applies.
            // setImmediate (next-tick) ensures the slash command's response
            // is logged before the "idle observed" banner.
            setImmediate(() => {
                this.onIdle({ aborted: false }).catch((err) =>
                    log(`autopilot: kickoff failed: ${err?.message ?? err}`, { level: "error" }),
                );
            });
        },

        async pause() {
            if (state.status !== "armed") {
                await log(`autopilot: cannot pause from status=${state.status}`, { level: "warning" });
                return;
            }
            const prev = state;
            await commit(prev, pause(state), "pause");
            await log(`autopilot PAUSED: "${state.goal}". /autopilot resume to continue.`);
        },

        async resume() {
            if (state.status !== "paused") {
                await log(`autopilot: cannot resume from status=${state.status}`, { level: "warning" });
                return;
            }
            const prev = state;
            await commit(prev, resume(state), "resume");
            await log(`autopilot RESUMED: "${state.goal}". Will fire on next idle.`);
        },

        async clearObjective() {
            const was = summarize(state);
            const prev = state;
            await commit(prev, clear(state), "clear");
            await log(`autopilot cleared (was: ${was})`);
        },

        async turnOff() {
            const was = summarize(state);
            const prev = state;
            await commit(prev, disable(state), "off");
            await log(`autopilot OFF (durable). Was: ${was}. /autopilot on to re-enable.`);
        },

        async turnOn() {
            if (state.enabled) {
                await log("autopilot is already enabled");
                return;
            }
            const prev = state;
            await commit(prev, enable(state), "on");
            await log("autopilot ON. No objective armed. /autopilot start <text> to begin.");
        },

        async show() { await log(summarize(state)); },

        // Plan-mode coupling: when the host switches to plan mode, auto-pause an
        // armed objective so we don't continue while the user is planning. Never
        // auto-resume — pure user-driven.
        async onModeChanged(data) {
            if (data?.newMode === "plan" && state.status === "armed") {
                const prev = state;
                await commit(prev, pause(state), "auto-pause for plan mode");
                await log(
                    `autopilot auto-paused for plan mode. /autopilot resume when ready.`,
                );
            }
        },

        // Termination detection: when the agent emits AUTOPILOT_COMPLETE, mark
        // complete so the next idle event won't fire another continuation.
        async onAssistantMessage(data) {
            if (state.status !== "armed") return;
            const summary = detectComplete(data?.content);
            if (!summary) return;
            const prev = state;
            await commit(prev, markComplete(state, summary), "mark complete");
            await log(`autopilot COMPLETE: ${summary}`);
        },

        async onIdle(data) {
            const decision = shouldFire(state, data);
            if (!decision.fire) {
                // Surface the spent transition so /autopilot show is accurate.
                if (state.status === "armed" && state.remainingTurns <= 0) {
                    const prev = state;
                    try {
                        await commit(prev, { ...state, status: "spent" }, "spent");
                    } catch { /* logged + reverted in commit */ }
                }
                return;
            }
            // Capture identity for staleness detection (Shadow review #2).
            // If the user runs /autopilot start with a new goal during grace,
            // state.goal will differ — we must NOT send the stale prompt.
            const capturedGoal = state.goal;
            // Tentative reservation: only mark inFlight here. Budget is
            // decremented AFTER grace (Shadow review #1) so cancelling during
            // grace doesn't burn a turn from the user's budget.
            const prev = state;
            try {
                await commit(prev, { ...state, inFlight: true }, "reserve idle");
            } catch { return; /* persistence failed; abort fire */ }

            await log(
                `autopilot: idle observed; grace=${GRACE_MS}ms before firing toward "${capturedGoal}". ` +
                `Cancel via /autopilot pause|off|clear.`,
            );
            await sleep(GRACE_MS);

            // Post-grace re-check. Cancel if any of: disabled, no longer armed,
            // OR objective changed (user replaced goal during grace).
            if (!state.enabled || state.status !== "armed" || state.goal !== capturedGoal) {
                const prev2 = state;
                try {
                    await commit(prev2, { ...state, inFlight: false }, "release reservation");
                } catch { /* swallowed via commit */ }
                await log(
                    `autopilot: cancelled during grace ` +
                    `(status=${state.status}, enabled=${state.enabled}, goalChanged=${state.goal !== capturedGoal})`,
                );
                return;
            }

            // Commit the fire: decrement budget + increment fired counter NOW.
            const prev3 = state;
            try {
                await commit(prev3, markFiring(state), "commit fire");
            } catch { return; /* if persistence fails, don't send */ }
            const goal = state.goal;
            const cap = state.hardCap;
            const fired = state.continuationsFired;

            setTimeout(async () => {
                try {
                    await session.send({
                        prompt: buildContinuationPrompt(goal, fired, cap),
                    });
                } catch (err) {
                    await log(`autopilot: send failed: ${err?.message ?? err}`, { level: "error" });
                } finally {
                    const prev4 = state;
                    try {
                        await commit(prev4, markFireSettled(state), "settle fire");
                    } catch { /* logged in commit */ }
                }
            }, 0);
        },
    };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function tokenCount(value) {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
