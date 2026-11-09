#!/usr/bin/env bash
# Tests harden-ssh.sh with stubbed sshd, systemctl and id, and temporary paths. It
# never reads or changes this machine's SSH setup.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../vps/harden-ssh.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat >"$work/bin/sshd" <<'EOF'
#!/bin/sh
echo "sshd $*" >>"$CALLS"
exit "${SSHD_STUB_STATUS:-0}"
EOF
cat >"$work/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >>"$CALLS"
EOF
printf '#!/bin/sh\necho 0\n' >"$work/bin/id"
chmod +x "$work/bin"/*
export PATH="$work/bin:$PATH"
for stub in sshd systemctl; do
  [ "$(command -v "$stub")" = "$work/bin/$stub" ] || { echo "The $stub stub is not first on PATH." >&2; exit 1; }
done

status=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; status=1; }

KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@example'

setup() {
  case_dir="$work/$1"
  mkdir -p "$case_dir/sshd_config.d" "$case_dir/.ssh" "$case_dir/run"
  chmod 700 "$case_dir/.ssh"
  export SSHD_CONFIG_DIR="$case_dir/sshd_config.d"
  export ROOT_AUTHORIZED_KEYS="$case_dir/.ssh/authorized_keys"
  export SSHD_RUN_DIR="$case_dir/run"
  export CALLS="$case_dir/calls"
  : >"$CALLS"
}

run() { "$script" 2>"$case_dir/stderr" >"$case_dir/stdout"; }
drop_in() { echo "$SSHD_CONFIG_DIR/10-nexus-ops-hardening.conf"; }
ran() { grep -qF -- "$1" "$CALLS"; }

setup with-key
printf '%s\n' "$KEY" >"$ROOT_AUTHORIZED_KEYS"
chmod 600 "$ROOT_AUTHORIZED_KEYS"
touch "$SSHD_CONFIG_DIR/50-cloud-init.conf"
if run && [ -f "$(drop_in)" ] \
  && grep -qx 'PasswordAuthentication no' "$(drop_in)" \
  && grep -qx 'KbdInteractiveAuthentication no' "$(drop_in)" \
  && grep -qx 'PermitRootLogin prohibit-password' "$(drop_in)"; then
  pass "a usable key gets the hardening drop-in"
else
  fail "the drop-in was not written"
fi
first="$(ls "$SSHD_CONFIG_DIR" | LC_ALL=C sort | head -n 1)"
if [ "$first" = "$(basename "$(drop_in)")" ]; then
  pass "the drop-in sorts before 50-cloud-init.conf"
else
  fail "the drop-in sorts after $first"
fi
if [ "$(grep -n 'sshd -t' "$CALLS" | cut -d: -f1)" -lt "$(grep -n 'systemctl' "$CALLS" | cut -d: -f1)" ]; then
  pass "the config is validated before sshd is reloaded"
else
  fail "sshd was reloaded before the config was validated"
fi

setup no-keys-file
if run && [ ! -e "$(drop_in)" ] && ! ran systemctl && grep -q 'unchanged' "$case_dir/stderr"; then
  pass "without authorized_keys nothing changes, and it says so"
else
  fail "SSH was changed without an authorized key"
fi

setup comments-only
printf '# a comment\n\n' >"$ROOT_AUTHORIZED_KEYS"
chmod 600 "$ROOT_AUTHORIZED_KEYS"
if run && [ ! -e "$(drop_in)" ] && ! ran systemctl; then
  pass "a file with only comments does not count as a key"
else
  fail "a keyless authorized_keys was accepted"
fi

setup forced-command
printf 'no-pty,command="echo Please login as ubuntu;sleep 10" %s\n' "$KEY" >"$ROOT_AUTHORIZED_KEYS"
chmod 600 "$ROOT_AUTHORIZED_KEYS"
if run && [ ! -e "$(drop_in)" ] && ! ran systemctl; then
  pass "a key restricted to a forced command does not count"
else
  fail "a forced-command key was accepted as a login key"
fi

setup writable-file
printf '%s\n' "$KEY" >"$ROOT_AUTHORIZED_KEYS"
chmod 664 "$ROOT_AUTHORIZED_KEYS"
if run && [ ! -e "$(drop_in)" ] && ! ran systemctl; then
  pass "a group-writable authorized_keys does not count"
else
  fail "a key file sshd would ignore was accepted"
fi

setup keeps-options
printf 'from="192.0.2.1" %s\n' "$KEY" >"$ROOT_AUTHORIZED_KEYS"
chmod 600 "$ROOT_AUTHORIZED_KEYS"
if run && [ -f "$(drop_in)" ]; then
  pass "a key with other options still counts"
else
  fail "a key with a from= option was rejected"
fi

setup rejected-config
printf '%s\n' "$KEY" >"$ROOT_AUTHORIZED_KEYS"
chmod 600 "$ROOT_AUTHORIZED_KEYS"
if SSHD_STUB_STATUS=1 run; then
  fail "a rejected config did not fail the run"
elif [ -e "$(drop_in)" ] || ran systemctl; then
  fail "a config sshd rejected was left in place or reloaded"
else
  pass "a config sshd rejects is removed and sshd is not reloaded"
fi

setup rejected-previous
printf '%s\n' "$KEY" >"$ROOT_AUTHORIZED_KEYS"
chmod 600 "$ROOT_AUTHORIZED_KEYS"
echo 'PermitRootLogin yes' >"$(drop_in)"
if SSHD_STUB_STATUS=1 run; then
  fail "a rejected config did not fail the run"
elif grep -qx 'PermitRootLogin yes' "$(drop_in)"; then
  pass "a rejected config restores the previous drop-in"
else
  fail "the previous drop-in was lost"
fi

exit "$status"
