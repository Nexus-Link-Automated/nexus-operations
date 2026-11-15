#!/bin/sh
# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.
#
# Installs the nexus-machine service for the current user; needs no root.
#
#   sh install.sh [path/to/nexus-machine.mjs]
#
# Puts the bundle in ~/.local/share/nexus-machine, a launcher in ~/.local/bin and a systemd user
# unit in ~/.config/systemd/user (or $XDG_CONFIG_HOME/systemd/user). Running it again upgrades in place and keeps your config.
set -eu

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

# Escape a value for a sed replacement (delimiter |) and for systemd, where % starts a specifier.
sed_value() {
  printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g' -e 's/%/%%/g'
}

# Quote a value for a POSIX shell script.
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux"
[ "$(id -u)" -ne 0 ] || die "run it as the person whose Codex and Claude sign-ins the machine should use, not as root"
[ -n "${HOME:-}" ] || die "HOME is not set"

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
bundle=${1:-}
if [ -z "$bundle" ]; then
  for candidate in "$script_dir/nexus-machine.mjs" "$script_dir/../dist/machine/nexus-machine.mjs"; do
    if [ -f "$candidate" ]; then
      bundle=$candidate
      break
    fi
  done
fi
[ -n "$bundle" ] && [ -f "$bundle" ] ||
  die "nexus-machine.mjs not found; build it first: pnpm --filter agent-runner build:machine"
unit_template="$script_dir/nexus-machine.service"
[ -f "$unit_template" ] || die "nexus-machine.service not found next to install.sh"

node_bin=${NODE:-$(command -v node || true)}
[ -n "$node_bin" ] || die "Node.js 24 or newer is required, and node is not on PATH (or set NODE=/path/to/node)"
node_major=$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 24 ] 2>/dev/null || die "Node.js 24 or newer is required; $node_bin is $("$node_bin" --version 2>/dev/null || echo unknown)"
case "$node_bin" in
  /*) ;;
  *) node_bin=$(CDPATH='' cd -- "$(dirname -- "$node_bin")" && pwd)/$(basename -- "$node_bin") ;;
esac

data_dir="$HOME/.local/share/nexus-machine"
bin_dir="$HOME/.local/bin"
# systemd looks for user units under $XDG_CONFIG_HOME too.
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/nexus-machine"
launcher="$bin_dir/nexus-machine"
env_file="$config_dir/env"
# The unit quotes these paths; systemd would read $, ", \ and newlines in them as syntax.
for value in "$launcher" "$env_file"; do
  case "$value" in
    *'$'* | *'"'* | *'\'* | *"
"*) die "cannot install under a path containing \$, \", \\ or a newline: $value" ;;
  esac
done

umask 077
mkdir -p "$data_dir" "$bin_dir" "$unit_dir" "$config_dir"
chmod 700 "$config_dir"

cp "$bundle" "$data_dir/nexus-machine.mjs.new"
mv -f "$data_dir/nexus-machine.mjs.new" "$data_dir/nexus-machine.mjs"

{
  echo "#!/bin/sh"
  echo "# Written by nexus-machine's install.sh."
  echo "exec $(sh_quote "$node_bin") $(sh_quote "$data_dir/nexus-machine.mjs") \"\$@\""
} >"$launcher.new"
chmod 755 "$launcher.new"
mv -f "$launcher.new" "$launcher"

# The service does not get your login shell's PATH; give it this one so it finds codex, claude
# and toolchains installed under your home. Written once: edit it freely afterwards.
if [ ! -e "$env_file" ]; then
  {
    echo "# Environment for the nexus-machine service (systemd EnvironmentFile syntax: KEY=value)."
    echo "# Add e.g. ANTHROPIC_API_KEY=... here if Claude should use an API key. Keep this file private."
    echo "PATH=$PATH"
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"; fi
  } >"$env_file"
  chmod 600 "$env_file"
else
  echo "Kept your existing $env_file."
fi

sed -e "s|@LAUNCHER@|$(sed_value "$launcher")|g" -e "s|@ENV_FILE@|$(sed_value "$env_file")|g" \
  "$unit_template" >"$unit_dir/nexus-machine.service.new"
chmod 644 "$unit_dir/nexus-machine.service.new"
mv -f "$unit_dir/nexus-machine.service.new" "$unit_dir/nexus-machine.service"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload 2>/dev/null || echo "Could not reach your systemd user manager; run: systemctl --user daemon-reload"
  # An upgrade: restart only if it was already running.
  systemctl --user try-restart nexus-machine.service 2>/dev/null || true
fi

version=$("$launcher" version 2>/dev/null || echo "?")
cat <<EOF
Installed nexus-machine $version.

Next:
  1. In the CRM, add a machine and copy its one-time join code. Then here:
       nexus-machine join https://<your CRM address> <join code>
  2. Start it now and at every login:
       systemctl --user enable --now nexus-machine
  3. Watch it:
       nexus-machine status
       journalctl --user -u nexus-machine -f

To keep it running while you are logged out:  loginctl enable-linger $(id -un)
EOF
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Note: $bin_dir is not on your PATH; use $launcher or add it to PATH." ;;
esac
