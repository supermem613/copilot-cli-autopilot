// commands.mjs
// Slash command parser + dispatcher. Single entry point:
//   makeMissionCommand(controllerRef, log) -> CommandDefinition for joinSession.
//
// controllerRef is { get(): controller | null } — a late-bound holder so the
// command can be passed to joinSession() before the controller (which needs
// the session) is constructed. Until controllerRef.get() returns non-null,
// commands respond with a "not ready" message. In practice this gap is
// effectively zero because init() runs immediately after joinSession returns.

const HELP = [
    "mission commands:",
    "  /mission <objective>  arm a new objective",
    "  /mission              print status and open the sidecar UX",
    "  /mission pause        suppress continuations (keeps objective)",
    "  /mission resume       un-pause or retry a blocked mission",
    "  /mission clear        clear objective (returns to idle)",
    "  /mission off          durable disable (persists across sessions)",
    "  /mission on           re-enable after off",
    "  /mission help         this message",
].join("\n");

export function makeMissionCommand(controllerRef, log) {
    return {
        name: "mission",
        description:
            "Autonomous turn continuation toward an objective. " +
            "Use /mission <objective>, then /mission pause | resume | clear",
        handler: async (ctx) => {
            const controller = controllerRef.get();
            if (!controller) {
                await log("mission: still initializing, try again", { level: "warning" });
                return;
            }
            const tail = ctx.command.replace(/^\/?mission\s*/i, "").trim();
            const [subRaw, ...rest] = tail.split(/\s+/);
            const sub = (subRaw || "show").toLowerCase();
            const arg = rest.join(" ").trim();

            switch (sub) {
                case "":
                case "show":
                case "status":
                    return controller.show();
                case "start":
                    if (/^--cap(?:\b|=)/.test(arg)) {
                        await log("mission: --cap is no longer supported. Usage: /mission <objective>",
                            { level: "warning" });
                        return;
                    }
                    if (arg) return controller.start(arg);
                    return controller.start(subRaw);
                case "pause":   return controller.pause();
                case "resume":  return controller.resume();
                case "clear":
                    return controller.clearObjective();
                case "off":     return controller.turnOff();
                case "on":      return controller.turnOn();
                case "help":    return log(HELP);
                default: {
                    if (/^--cap(?:\b|=)/.test(tail)) {
                        await log("mission: --cap is no longer supported. Usage: /mission <objective>",
                            { level: "warning" });
                        return;
                    }
                    return controller.start(tail);
                }
            }
        },
    };
}
