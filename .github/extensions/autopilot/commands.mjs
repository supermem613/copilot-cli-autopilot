// commands.mjs
// Slash command parser + dispatcher. Single entry point:
//   makeAutopilotCommand(controllerRef, log) -> CommandDefinition for joinSession.
//
// controllerRef is { get(): controller | null } — a late-bound holder so the
// command can be passed to joinSession() before the controller (which needs
// the session) is constructed. Until controllerRef.get() returns non-null,
// commands respond with a "not ready" message. In practice this gap is
// effectively zero because init() runs immediately after joinSession returns.

// Hard ceiling on user-supplied --cap. Independent of the default hardCap so
// power users can dial up but can't accidentally request 1000 turns.
const MAX_HARD_CAP = 100;

const HELP = [
    "autopilot subcommands:",
    "  /autopilot start [--cap N] <objective>  arm a new objective (default cap 20, max 100)",
    "  /autopilot show               print current status",
    "  /autopilot pause              suppress continuations (keeps objective)",
    "  /autopilot resume             un-pause",
    "  /autopilot clear              clear objective (returns to idle)",
    "  /autopilot off                durable disable (persists across sessions)",
    "  /autopilot on                 re-enable after off",
    "  /autopilot help               this message",
].join("\n");

export function makeAutopilotCommand(controllerRef, log) {
    return {
        name: "autopilot",
        description:
            "Autonomous turn continuation toward an objective. " +
            "Subcommands: start <text> | show | pause | resume | clear | off | on | help",
        handler: async (ctx) => {
            const controller = controllerRef.get();
            if (!controller) {
                await log("autopilot: still initializing, try again", { level: "warning" });
                return;
            }
            const tail = ctx.command.replace(/^\/?autopilot\s*/i, "").trim();
            const [subRaw, ...rest] = tail.split(/\s+/);
            const sub = (subRaw || "show").toLowerCase();
            const arg = rest.join(" ").trim();

            switch (sub) {
                case "":
                case "show":
                case "status":
                    return controller.show();
                case "start": {
                    if (!arg) {
                        await log("autopilot: missing objective. Usage: /autopilot start [--cap N] <objective>",
                            { level: "warning" });
                        return;
                    }
                    // Optional --cap N flag. Accepts --cap=N or --cap N. The
                    // remainder is the objective text.
                    // Detect the --cap prefix BEFORE validating digits so
                    // "--cap abc <goal>" rejects loudly instead of silently
                    // taking "--cap abc <goal>" as the goal text.
                    const opts = {};
                    let goal = arg;
                    if (/^--cap\b/.test(goal)) {
                        const capMatch = goal.match(/^--cap[= ]([^\s]+)\s+(.+)$/);
                        if (!capMatch) {
                            await log("autopilot: --cap must be followed by a number and an objective. " +
                                "Usage: /autopilot start --cap 5 <objective>", { level: "warning" });
                            return;
                        }
                        const n = Number.parseInt(capMatch[1], 10);
                        if (!Number.isInteger(n) || n <= 0 || String(n) !== capMatch[1]) {
                            await log(`autopilot: --cap must be a positive integer (got "${capMatch[1]}")`,
                                { level: "warning" });
                            return;
                        }
                        if (n > MAX_HARD_CAP) {
                            await log(`autopilot: --cap clamped from ${n} to ${MAX_HARD_CAP} (safety ceiling)`,
                                { level: "warning" });
                            opts.hardCap = MAX_HARD_CAP;
                        } else {
                            opts.hardCap = n;
                        }
                        goal = capMatch[2].trim();
                    }
                    return controller.start(goal, opts);
                }
                case "pause":   return controller.pause();
                case "resume":  return controller.resume();
                case "clear":
                case "stop":
                    return controller.clearObjective();
                case "off":     return controller.turnOff();
                case "on":      return controller.turnOn();
                case "help":    return log(HELP);
                default:
                    await log(`autopilot: unknown subcommand "${sub}"\n${HELP}`, { level: "warning" });
            }
        },
    };
}
