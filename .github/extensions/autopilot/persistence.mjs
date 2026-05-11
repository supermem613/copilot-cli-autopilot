// Persist state to <workspacePath>/autopilot.json.
// Fail loud at session start when workspacePath is undefined — Skeptic's FATAL #2.
// Without persistence, "off" would not survive a /clear and an armed objective
// would not survive a session resume.

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { normalizeState, makeDefaultState } from "./state.mjs";

export class WorkspaceUnavailable extends Error {
    constructor() {
        super(
            "autopilot requires session.workspacePath but it is undefined. " +
            "Enable infinite sessions or remove the autopilot extension."
        );
        this.name = "WorkspaceUnavailable";
    }
}

export function statePath(workspacePath) {
    if (!workspacePath) throw new WorkspaceUnavailable();
    return join(workspacePath, "autopilot.json");
}

// Volatile fields — never persisted. They reflect runtime telemetry that
// would be stale on the next session. Cleared on save and on load.
// (Shadow review: stale context tokens shown after resume.)
const VOLATILE_FIELDS = [
    "contextTokens",
    "contextMaxTokens",
    "contextUpdatedAt",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "tokenUpdatedAt",
];
const TOKEN_COUNTER_FIELDS = new Set([
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
]);

function stripVolatile(state) {
    const out = { ...state };
    for (const k of VOLATILE_FIELDS) delete out[k];
    return out;
}

export async function loadState(workspacePath) {
    const path = statePath(workspacePath);
    try {
        const raw = await fs.readFile(path, "utf8");
        const parsed = normalizeState(JSON.parse(raw));
        // Belt-and-braces: also strip on load in case a prior version
        // accidentally persisted these.
        for (const k of VOLATILE_FIELDS) parsed[k] = TOKEN_COUNTER_FIELDS.has(k) ? 0 : null;
        return parsed;
    } catch (err) {
        if (err.code === "ENOENT") return makeDefaultState();
        throw err;
    }
}

// Atomic-ish write: tmp + rename. Avoids torn writes if the process dies mid-save.
export async function saveState(workspacePath, state) {
    const path = statePath(workspacePath);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(stripVolatile(state), null, 2), "utf8");
    await fs.rename(tmp, path);
}
