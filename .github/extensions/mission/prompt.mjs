// Continuation prompt template + MISSION_COMPLETE detection.
// Kept tiny because Shadow flagged: continuation prompts render in the TUI as
// user-style messages, so users see this text inline. Be terse.

export const COMPLETE_TOKEN = "MISSION_COMPLETE:";
export const LEGACY_COMPLETE_TOKEN = "AUTOPILOT_COMPLETE:";

export function buildContinuationPrompt(goal, fired) {
    return (
        `[mission turn ${fired}] Continue toward: "${goal}"\n` +
        `When the objective is fully met, end your reply with a line:\n` +
        `${COMPLETE_TOKEN} <one-sentence summary>\n` +
        `Otherwise take the next concrete step.`
    );
}

// Returns the summary string when the message contains a COMPLETE token at
// the start of a line, else null. The line-anchor matters: this prevents
// false positives when the agent merely *discusses* the token (e.g. while
// explaining the mission mechanism, as it might in a debugging session).
export function detectComplete(content) {
    if (!content || typeof content !== "string") return null;
    // Match start-of-string OR start-of-line (after newline, optionally preceded by whitespace).
    const tokens = [COMPLETE_TOKEN, LEGACY_COMPLETE_TOKEN]
        .map((token) => token.replace(":", "\\:"))
        .join("|");
    const re = new RegExp(`(?:^|\\n)\\s*(?:${tokens})\\s*(.*)`, "m");
    const m = content.match(re);
    if (!m) return null;
    const tail = m[1] ?? "";
    const lineEnd = tail.indexOf("\n");
    const summary = (lineEnd === -1 ? tail : tail.slice(0, lineEnd)).trim();
    return summary || "(no summary provided)";
}
