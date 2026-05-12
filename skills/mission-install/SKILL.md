---
name: mission-install
description: Use when installing, enabling, setting up, or repairing the Copilot CLI mission /mission command and sidecar by installing the user-scoped SDK extension shim from the installed plugin.
---

Use this skill when the user asks to install, enable, set up, or repair the Copilot CLI `/mission` command after installing the plugin.

Goal:

- Locate the installed `copilot-cli-mission` plugin under the user's Copilot installed plugins directory.
- Run the plugin's deterministic shim installer script.
- Remove the legacy user-scoped `autopilot` shim when the installer recognizes it as this plugin's old shim.
- Tell the user to enable or reload the `mission` user extension in `/extensions` if it is not already running.

Use the command for the user's shell.

PowerShell:

```powershell
$installer = Get-ChildItem "$env:USERPROFILE\.copilot\installed-plugins" -Directory -Recurse |
  Where-Object {
    (Test-Path (Join-Path $_.FullName "scripts\install-extension-shim.mjs")) -and
    (Test-Path (Join-Path $_.FullName ".github\extensions\mission\extension.mjs"))
  } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $installer) {
  throw "Could not find the installed copilot-cli-mission plugin. Run: copilot plugin install supermem613/copilot-cli-mission"
}

node (Join-Path $installer "scripts\install-extension-shim.mjs")
```

Bash/zsh:

```bash
installer="$(find "$HOME/.copilot/installed-plugins" -type f -path '*/scripts/install-extension-shim.mjs' | while read -r f; do root="$(dirname "$(dirname "$f")")"; if [ -f "$root/.github/extensions/mission/extension.mjs" ]; then printf '%s\n' "$f"; break; fi; done)"
if [ -z "$installer" ]; then
  echo "Could not find the installed copilot-cli-mission plugin. Run: copilot plugin install supermem613/copilot-cli-mission" >&2
  exit 1
fi
node "$installer"
```

After the script succeeds, instruct the user:

1. Run `/extensions`.
2. Enable `mission` under **User**, or reload it if it was already enabled.
3. Run `/mission help` to confirm the command is available.

Do not overwrite unrelated user extensions. If the installer reports that it refused to overwrite an existing non-mission extension or a symlink/junction, stop and explain — the user already has a user extension named `mission` (likely a dev-loop checkout).
