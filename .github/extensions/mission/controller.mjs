// Lifecycle controller. Owns the in-memory state and is the only place that
// mutates it. Exposes high-level operations (start, pause, resume, ...) that
// commands.mjs and the event handlers in extension.mjs call.
//
// Invariants (enforced here so commands.mjs stays declarative):
//   - Every mutation that changes persisted fields calls saveState before returning.
//   - All session.send() calls are deferred via setTimeout(0) to avoid reentrancy
//     with the idle event that triggered them.
//   - The grace window between "idle observed" and "send fired" gives the user
//     a chance to cancel via /mission pause|clear without burning a turn.

import {
    arm, pause, resume, clear,
    markFiring, markFireSettled, markComplete, markBlocked,
    shouldFire, summarize,
} from "./state.mjs";
import { loadState, saveState } from "./persistence.mjs";
import { buildContinuationPrompt, detectBlocked, detectComplete } from "./prompt.mjs";

export const GRACE_MS = 1500;

export function createController({ session, workspacePath, log, onStateChange, onShow }) {
    let state;
    let shuttingDown = false;
    const activeTasks = new Set();
    const sendTimers = new Set();
    const shutdownController = new AbortController();
    let kickoffTimer = null;
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

    function track(task) {
        const tracked = Promise.resolve(task);
        activeTasks.add(tracked);
        tracked.then(
            () => activeTasks.delete(tracked),
            () => activeTasks.delete(tracked),
        );
        return tracked;
    }

    function clearKickoff() {
        if (!kickoffTimer) return;
        clearImmediate(kickoffTimer);
        kickoffTimer = null;
    }

    function scheduleKickoff(fn) {
        clearKickoff();
        kickoffTimer = setImmediate(() => {
            kickoffTimer = null;
            if (shuttingDown) return;
            track(fn());
        });
    }

    function scheduleSend(fn) {
        const timer = setTimeout(() => {
            sendTimers.delete(timer);
            if (shuttingDown) return;
            track(fn());
        }, 0);
        sendTimers.add(timer);
    }

    async function drainActiveTasks() {
        while (activeTasks.size > 0) {
            await Promise.allSettled([...activeTasks]);
        }
    }

    // Fire-and-forget notification to the sidecar (or any listener). Errors
    // here are advisory only — they must NOT roll back a successful commit.
    function notify() {
        if (!onStateChange) return;
        Promise.resolve().then(() => onStateChange({ ...state })).catch((err) => {
            log(`mission: state notify failed: ${err?.message ?? err}`, { level: "warning" })
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
            await log(`mission: ${label} failed (disk write): ${err?.message ?? err}. Reverted.`,
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
                `mission loaded: ${summarize(state)} (workspace: ${workspacePath})`,
                { ephemeral: true },
            );
            notify();
            if (state.status === "armed") {
                await log("mission: restored armed objective; checking idle state for continuation", { ephemeral: true });
                scheduleKickoff(() =>
                    this.onIdle({ aborted: false }).catch((err) =>
                        log(`mission: restore kickoff failed: ${err?.message ?? err}`, { level: "error" }),
                    )
                );
            }
        },

        get snapshot() { return { ...state }; },

        summary() { return summarize(state); },

        async shutdown() {
            shuttingDown = true;
            clearKickoff();
            for (const timer of sendTimers) clearTimeout(timer);
            sendTimers.clear();
            shutdownController.abort();
            await drainActiveTasks();
            await writeQueue.catch(() => {});
        },

        // Coarse context-window tracking. Updated on session.usage_info.
        // In-memory only because it reflects point-in-time context pressure.
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
            track(persist().catch((err) =>
                log(`mission: token counter persist failed: ${err?.message ?? err}`, { level: "warning" })
            ));
            notify();
        },

        async start(goal) {
            const wasActive = state.status === "armed" || state.status === "paused";
            // Replacement confirmation — capability-gated; if elicitation isn't
            // available we proceed (with a warning), preserving Codex parity
            // where /goal silently replaces the active objective.
            if (wasActive && session.capabilities?.ui?.elicitation) {
                const ok = await session.ui.confirm(
                    `Replace current mission objective?\n` +
                    `  current: "${state.goal}" (${state.continuationsFired} turns)\n` +
                    `  new:     "${goal}"`
                );
                if (!ok) {
                    await log("mission: replacement declined; keeping current objective");
                    return;
                }
            } else if (wasActive) {
                await log(`mission: replacing active objective "${state.goal}"`, { level: "warning" });
            }
            const prev = state;
            await commit(prev, arm(state, goal), "start");
            await log(
                `mission ARMED: "${goal}" [grace=${GRACE_MS}ms]. ` +
                `Will fire on next idle. /mission pause to stop.`,
            );
            if (onShow) {
                await onShow({ ...state });
            }
            // Kick off immediately — slash commands don't trigger session.idle on
            // their own, so without this the user would have to send a separate
            // prompt to start the loop. We synthesize an idle event with
            // aborted=false so the normal grace+recheck path applies.
            // setImmediate (next-tick) ensures the slash command's response
            // is logged before the "idle observed" banner.
            scheduleKickoff(() =>
                this.onIdle({ aborted: false }).catch((err) =>
                    log(`mission: kickoff failed: ${err?.message ?? err}`, { level: "error" }),
                )
            );
        },

        async pause() {
            if (state.status !== "armed") {
                await log(`mission: cannot pause from status=${state.status}`, { level: "warning" });
                return;
            }
            const prev = state;
            await commit(prev, pause(state), "pause");
            await log(`mission PAUSED: "${state.goal}". /mission resume to continue.`);
        },

        async resume() {
            if (state.status !== "paused" && state.status !== "blocked") {
                await log(`mission: cannot resume from status=${state.status}`, { level: "warning" });
                return;
            }
            const prev = state;
            await commit(prev, resume(state), "resume");
            await log(`mission RESUMED: "${state.goal}". Will fire on next idle.`);
            if (onShow) {
                await onShow({ ...state });
            }
            scheduleKickoff(() =>
                this.onIdle({ aborted: false }).catch((err) =>
                    log(`mission: resume kickoff failed: ${err?.message ?? err}`, { level: "error" }),
                )
            );
        },

        async clearObjective() {
            const was = summarize(state);
            const prev = state;
            await commit(prev, clear(state), "clear");
            await log(`mission cleared (was: ${was})`);
        },

        async show() {
            await log(summarize(state));
            if (onShow) {
                await onShow({ ...state });
            }
        },

        // Plan-mode coupling: when the host switches to plan mode, auto-pause an
        // armed objective so we don't continue while the user is planning. Never
        // auto-resume — pure user-driven.
        async onModeChanged(data) {
            if (data?.newMode === "plan" && state.status === "armed") {
                const prev = state;
                await commit(prev, pause(state), "auto-pause for plan mode");
                await log(
                    `mission auto-paused for plan mode. /mission resume when ready.`,
                );
            }
        },

        // Termination detection: complete and blocked are both terminal. The
        // blocked path prevents spend loops when the agent knows it cannot
        // make meaningful progress without user input.
        async onAssistantMessage(data) {
            if (state.status !== "armed") return;
            const summary = detectComplete(data?.content);
            if (summary) {
                const prev = state;
                await commit(prev, markComplete(state, summary), "mark complete");
                await log(`mission COMPLETE: ${summary}`);
                return;
            }
            const blockedSummary = detectBlocked(data?.content);
            if (!blockedSummary) return;
            const prev = state;
            await commit(prev, markBlocked(state, blockedSummary), "mark blocked");
            await log(`mission BLOCKED: ${blockedSummary}. Waiting for user input.`);
        },

        async onIdle(data) {
            if (shuttingDown) return;
            const decision = shouldFire(state, data);
            if (!decision.fire) {
                return;
            }
            // Capture identity for staleness detection (Shadow review #2).
            // If the user runs /mission with a new goal during grace,
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
                `mission: idle observed; grace=${GRACE_MS}ms before firing toward "${capturedGoal}". ` +
                `Cancel via /mission pause.`,
            );
            const graceElapsed = await sleep(GRACE_MS, shutdownController.signal);
            if (!graceElapsed) {
                const prev2 = state;
                try {
                    await commit(prev2, { ...state, inFlight: false }, "release reservation");
                } catch { /* logged + reverted in commit */ }
                return;
            }

            // Post-grace re-check. Cancel if no longer armed OR objective changed
            // (user replaced goal during grace).
            if (shuttingDown || !state.enabled || state.status !== "armed" || state.goal !== capturedGoal) {
                const prev2 = state;
                try {
                    await commit(prev2, { ...state, inFlight: false }, "release reservation");
                } catch { /* swallowed via commit */ }
                await log(
                    `mission: cancelled during grace ` +
                    `(status=${state.status}, enabled=${state.enabled}, goalChanged=${state.goal !== capturedGoal})`,
                );
                return;
            }

            // Commit the fire: increment fired counter NOW.
            const prev3 = state;
            try {
                await commit(prev3, markFiring(state), "commit fire");
            } catch { return; /* if persistence fails, don't send */ }
            const goal = state.goal;
            const fired = state.continuationsFired;

            scheduleSend(async () => {
                try {
                    await session.send({
                        prompt: buildContinuationPrompt(goal, fired),
                    });
                } catch (err) {
                    await log(`mission: send failed: ${err?.message ?? err}`, { level: "error" });
                } finally {
                    const prev4 = state;
                    try {
                        await commit(prev4, markFireSettled(state), "settle fire");
                    } catch { /* logged in commit */ }
                }
            });
        },
    };
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function tokenCount(value) {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
