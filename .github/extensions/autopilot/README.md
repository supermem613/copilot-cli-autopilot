# autopilot — autonomous turn continuation

A Copilot CLI extension. Tell it your objective once with `/autopilot start <objective>`. It nudges the agent to keep working toward that objective, one continuation per idle turn, until the objective is met (the agent emits `AUTOPILOT_COMPLETE: <summary>`) or the turn cap (default 20) is exhausted.

This is a Copilot CLI extension inspired by Codex's `/goal` feature — built as a pure extension with no host-side changes.

## Install

The extension lives at `~/.copilot/extensions/autopilot/`. Reload extensions or restart the Copilot CLI to pick it up. **Requires infinite sessions** (the extension fails loud if `session.workspacePath` is unavailable — see Non-Goals).

## Use

```
/autopilot start refactor src/foo.ts to remove the global mutex
```

Then send any prompt (or just press Enter on an empty turn) to start the loop. The agent works one turn, becomes idle, autopilot waits ~1.5s (grace window — your chance to cancel), then injects a continuation prompt visible in the timeline:

```
[autopilot 1/20] Continue toward: "refactor src/foo.ts to remove the global mutex"
When the objective is fully met, end your reply with a line:
AUTOPILOT_COMPLETE: <one-sentence summary>
Otherwise take the next concrete step.
```

The agent works another turn. Loop continues. When the agent finishes, it emits the `AUTOPILOT_COMPLETE:` line and autopilot stops automatically.

## Commands

| Command | Effect |
| --- | --- |
| `/autopilot start <objective>` | Arm a new objective. If one is active, you're asked to confirm replacement (when the host supports it). |
| `/autopilot show` | Print current status, objective, and remaining budget. |
| `/autopilot pause` | Suppress continuations; objective is preserved. |
| `/autopilot resume` | Un-pause. |
| `/autopilot clear` | Drop the objective; return to idle. |
| `/autopilot off` | **Durable** disable. Persists across sessions. |
| `/autopilot on` | Re-enable after `off`. |
| `/autopilot help` | Subcommand list. |

Cancelling during the grace window via `pause`, `clear`, or `off` prevents the next continuation from firing — no model spend.

Pressing Ctrl-C during a continuation also aborts cleanly: autopilot honors `session.idle.aborted` and will not fire the next continuation.

Switching to plan mode auto-pauses an armed objective. Autopilot never auto-resumes — that's always your call.

## State

Persisted to `<session-workspace>/autopilot.json`. Survives `/clear` and session resume. Inspect or hand-edit if you really want; `inFlight: true` is forced to `false` on load (a process restart invalidates any in-flight send).

## Non-goals (and why)

These differ from Codex's `/goal` because the Copilot CLI extension API doesn't expose the necessary surfaces. Building hacks around those gaps would mean fragile UX, not parity.

| Codex feature | Status here | Why |
| --- | --- | --- |
| Persistent footer / statusline showing the active objective | **Not provided.** | The CLI exposes `session.log()` to the scrollback timeline only. There is no extension-visible footer/statusline channel. We tried OSC 0 escape sequences (`ESC ] 0 ; <text> BEL`) to write the terminal title bar from the extension subprocess; the host PTY captures and discards them. Confirmed dead end. |
| Notification suppression while continuations fire | **Not provided.** | No SDK API for muting notifications from an extension. |
| Exact token budget tracking | **Approximate.** | The sidecar accumulates root-agent `assistant.usage` input/output/cache/reasoning token deltas while an objective is active. SDK usage events can undercount sub-agent and MCP token usage. The hard turn cap is the durable safety; budget reporting is best-effort. |
| Works without infinite sessions | **No.** | Without `session.workspacePath` the durable `off` flag and an active objective would silently vanish on `/clear` or resume. We fail loud at startup rather than pretend to work. |

## Safety / kill switches

- **Hard turn cap** (default 20). Independent of objective wording. Once spent, autopilot won't fire again until `/autopilot start <new>`.
- **Grace window** (1.5s). Cancellation paths (`pause` / `clear` / `off`) checked after grace; if state changed, no send.
- **Abort honor.** Ctrl-C sets `session.idle.aborted=true`; autopilot skips the continuation.
- **Plan-mode auto-pause.** Switching the host to plan mode pauses an armed objective. Manual resume only.
- **Durable disable.** `/autopilot off` persists; survives session resume and `/clear`.

## Sidecar viewer

When an objective is armed (status: `armed`, `paused`, `spent`, or `complete`), autopilot opens a small chromeless browser window with:

![Autopilot sidecar showing status, token panels, and pause/stop controls](./docs/autopilot-sidecar.png)

- **Status badge** — `armed` / `paused` / `spent` / `complete`, with a `· firing` suffix while a continuation is in-flight.
- **Active objective** — wrapped, full-text.
- **Turns** — fired / cap.
- **Elapsed timer** — live ticking since the objective was armed.
- **Token consumption** — separate best-effort root-agent `assistant.usage` totals for input and output tokens. Counters reset on each new objective and are not persisted across extension reloads.
- **Controls** — large icon buttons for `Pause` / `Resume` and `Stop`.

The window auto-closes when status returns to `idle` (cleared) or autopilot is turned off.

Implementation: zero-dep `node:http` + hand-rolled WebSocket on `127.0.0.1` (OS-assigned port), token-gated, opened via `msedge --app=` (or `chrome --app=`). Profile dir at `~/.copilot/autopilot-viewer-profile/`. Same proven pattern as the backlog sidecar.

## Hard cap override

```
/autopilot start --cap 5 finish writing the migration script
/autopilot start --cap=10 ship the bugfix
```

`--cap` accepts a positive integer between 1 and 100. Above 100 it's clamped (with a warning) for safety.

## File layout

```
~/.copilot/extensions/autopilot/
├── extension.mjs    SDK wiring (joinSession, event handlers)
├── controller.mjs   Lifecycle controller (the only thing that mutates state)
├── state.mjs        Pure state machine + decision predicate
├── commands.mjs     Slash command parser
├── persistence.mjs  autopilot.json load/save
├── prompt.mjs       Continuation prompt template + AUTOPILOT_COMPLETE detection
├── sidecar.mjs      127.0.0.1 HTTP+WS server + chromeless viewer launcher
├── viewer.html      Single-file dark-card UI rendered in the sidecar window
├── tests/           node:assert smoke tests (run individually with `node tests/<file>`)
└── README.md
```

The strict module split (commands → controller → state-machine → effects → host-bindings) is the architecture even though only one tenant (`/autopilot`) ships today. Adding a second tenant later (e.g. a generic "continuation engine" used by other extensions) shouldn't require a rewrite.
