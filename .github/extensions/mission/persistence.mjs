// Persist state to <workspacePath>/mission.json.
// Fail loud at session start when workspacePath is undefined — Skeptic's FATAL #2.
// Without persistence, an armed objective would not survive a session resume.

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { normalizeState, makeDefaultState } from "./state.mjs";

export class WorkspaceUnavailable extends Error {
    constructor() {
        super(
            "mission requires session.workspacePath but it is undefined. " +
            "Enable infinite sessions or remove the mission extension."
        );
        this.name = "WorkspaceUnavailable";
    }
}

export function statePath(workspacePath) {
    if (!workspacePath) throw new WorkspaceUnavailable();
    return join(workspacePath, "mission.json");
}

function legacyStatePath(workspacePath) {
    if (!workspacePath) throw new WorkspaceUnavailable();
    return join(workspacePath, "autopilot.json");
}

// Volatile fields — never persisted. Context-window pressure is point-in-time
// telemetry and would be stale on the next session.
const VOLATILE_FIELDS = [
    "contextTokens",
    "contextMaxTokens",
    "contextUpdatedAt",
];
const DEPRECATED_FIELDS = [
    "hardCap",
    "remainingTurns",
];

function stripVolatile(state) {
    const out = { ...state };
    for (const k of VOLATILE_FIELDS) delete out[k];
    for (const k of DEPRECATED_FIELDS) delete out[k];
    return out;
}

export async function loadState(workspacePath) {
    const path = statePath(workspacePath);
    try {
        const raw = await fs.readFile(path, "utf8");
        return normalizeLoadedState(raw);
    } catch (err) {
        if (err.code === "ENOENT") return loadLegacyState(workspacePath);
        throw err;
    }
}

async function loadLegacyState(workspacePath) {
    const legacyPath = legacyStatePath(workspacePath);
    try {
        const raw = await fs.readFile(legacyPath, "utf8");
        const parsed = normalizeLoadedState(raw);
        await saveState(workspacePath, parsed);
        await fs.unlink(legacyPath);
        return parsed;
    } catch (err) {
        if (err.code === "ENOENT") return makeDefaultState();
        throw err;
    }
}

function normalizeLoadedState(raw) {
    const parsed = normalizeState(JSON.parse(raw));
    // Belt-and-braces: also strip on load in case a prior version
    // accidentally persisted these.
    for (const k of VOLATILE_FIELDS) parsed[k] = null;
    for (const k of DEPRECATED_FIELDS) delete parsed[k];
    return parsed;
}

// Atomic-ish write: tmp + rename. Avoids torn writes if the process dies mid-save.
export async function saveState(workspacePath, state) {
    const path = statePath(workspacePath);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(stripVolatile(state), null, 2), "utf8");
    await fs.rename(tmp, path);
}
