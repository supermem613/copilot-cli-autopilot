# copilot-cli-autopilot

A GitHub Copilot CLI extension that **autonomously continues turns toward a stated objective**, with a live sidecar viewer for status and one-click control.

Tell autopilot your goal once with `/autopilot start <objective>`. It nudges the agent to keep working toward that objective, one continuation per idle turn, until the agent emits `AUTOPILOT_COMPLETE: <summary>` or the turn cap is exhausted.

A chromeless sidecar window opens automatically while a goal is armed, showing the live status, continuations fired vs. cap, elapsed time, context-window pressure, and big buttons for **Pause / Resume / Clear / Turn off** that work even mid-turn (they bypass the host's slash-command queue).

Inspired by Codex's `/goal` feature — built as a pure Copilot CLI extension with no host-side changes.

## Install

### 1. Enable experimental Copilot CLI extensions

In a Copilot CLI session:

```
/experimental
```

Enable the **Extensions** feature. If your Copilot CLI version does not show that option, add `"EXTENSIONS"` to `experimental_flags` in `~/.copilot/config.json` and restart.

### 2. Install the plugin from GitHub

```
copilot plugin install supermem613/copilot-cli-autopilot
```

Verify:

```
copilot plugin list
```

### 3. Enable the `/autopilot` extension

The plugin install puts the package on disk. The `/autopilot` command and sidecar are loaded as a Copilot CLI SDK extension discovered from the user extensions folder.

Easiest path — in a Copilot CLI session, run:

```
Use the autopilot-install skill to enable the /autopilot command.
```

The skill installs a small user-scoped delegate at `~/.copilot/extensions/autopilot/extension.mjs` that imports the SDK extension from the plugin install location.

If you prefer to do it by hand, paste this into your shell after `copilot plugin install` completes:

PowerShell:

```powershell
$installer = Get-ChildItem "$env:USERPROFILE\.copilot\installed-plugins" -Directory -Recurse |
  Where-Object { Test-Path (Join-Path $_.FullName "scripts\install-extension-shim.mjs") } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $installer) { throw "Could not find installed copilot-cli-autopilot plugin." }

node (Join-Path $installer "scripts\install-extension-shim.mjs")
```

Bash/zsh:

```bash
installer="$(find "$HOME/.copilot/installed-plugins" -type f -path '*/scripts/install-extension-shim.mjs' | head -n 1)"
if [ -z "$installer" ]; then echo "Could not find installed copilot-cli-autopilot plugin." >&2; exit 1; fi
node "$installer"
```

In Copilot CLI:

```
/extensions
```

Enable `autopilot` under **User**. Then run `/autopilot help` to confirm.

## Use

```
/autopilot start refactor src/foo.ts to remove the global mutex
/autopilot start --cap 5 ship the bugfix
/autopilot show
/autopilot pause
/autopilot resume
/autopilot clear
/autopilot off            # durable disable
/autopilot on
```

The agent works one turn, becomes idle, autopilot waits ~1.5s (grace window — your chance to cancel), then injects a continuation prompt visible in the timeline:

```
[autopilot 1/20] Continue toward: "refactor src/foo.ts to remove the global mutex"
When the objective is fully met, end your reply with a line:
AUTOPILOT_COMPLETE: <one-sentence summary>
Otherwise take the next concrete step.
```

When the agent finishes, it emits the `AUTOPILOT_COMPLETE:` line and autopilot stops automatically.

The sidecar window (chromeless `msedge --app=` on Windows; falls back to default browser elsewhere) is open while a goal is active. Click **Pause / Resume / Clear / Turn off** any time — the buttons hit a localhost HTTP endpoint that bypasses the host's slash-command queue, so they work *during* an in-flight LLM turn.

See [`.github/extensions/autopilot/README.md`](./.github/extensions/autopilot/README.md) for the full command reference, safety/kill-switches, non-goals, and architecture notes.

## Develop

```bash
git clone https://github.com/supermem613/copilot-cli-autopilot.git
cd copilot-cli-autopilot
npm run check    # node --check on every .mjs
npm test         # 4 test files, 28 assertions
```

To run your local working tree as the live extension (instead of the installed plugin), drop a one-line shim at `~/.copilot/extensions/autopilot/extension.mjs` that dynamic-imports your working tree. **Do not** point the directory itself at the working tree with a junction or symlink — Copilot CLI's extension loader does not pick those up.

```powershell
# Windows
$ext = "$env:USERPROFILE\.copilot\extensions\autopilot"
Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $ext | Out-Null
$target = "$PWD\.github\extensions\autopilot\extension.mjs"
@"
import { pathToFileURL } from "node:url";
await import(pathToFileURL($($target | ConvertTo-Json)).href);
"@ | Set-Content -Path "$ext\extension.mjs" -NoNewline
```

```bash
# macOS / Linux
ext="$HOME/.copilot/extensions/autopilot"
rm -rf "$ext"
mkdir -p "$ext"
target="$PWD/.github/extensions/autopilot/extension.mjs"
cat > "$ext/extension.mjs" <<EOF
import { pathToFileURL } from "node:url";
await import(pathToFileURL("$target").href);
EOF
```

Then `/extensions` → reload `autopilot`. Edits to the working tree take effect on the next `extensions reload` (the shim is just a delegate; your working tree is the real source).

## Repo layout

```
copilot-cli-autopilot/
├── .github/
│   ├── extensions/autopilot/    SDK extension (extension.mjs + 6 modules + viewer.html + tests)
│   └── workflows/ci.yml         Cross-platform CI: node --check + tests on Node 22 & 24
├── scripts/
│   └── install-extension-shim.mjs   Writes the user-scoped delegate after plugin install
├── skills/
│   └── autopilot-install/SKILL.md   Setup skill the user invokes from a Copilot CLI session
├── plugin.json                  Plugin metadata (name, version, skills dir)
├── package.json                 npm scripts (check, test)
├── LICENSE                      MIT
└── README.md                    (this file)
```

## License

MIT © Marcus Markiewicz
