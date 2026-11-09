#!/usr/bin/env bash
# Turns off SSH password logins and limits root to keys, using a drop-in that sorts
# before 50-cloud-init.conf: sshd keeps the first value it reads for each option, and
# cloud images often turn passwords on in that file.
#
# So that nobody gets locked out, it changes nothing unless root has an authorized key
# that can open a shell, and a config `sshd -t` rejects is taken out before sshd is
# reloaded. bootstrap.sh runs this; run it again after adding a key if bootstrap
# skipped it. Run as root.
#
# Environment overrides, used by deployments/hybrid/test:
#   SSHD_CONFIG_DIR        drop-in directory (default: /etc/ssh/sshd_config.d)
#   ROOT_AUTHORIZED_KEYS   root's authorized_keys (default: /root/.ssh/authorized_keys)
#   SSHD_RUN_DIR           directory `sshd -t` needs (default: /run/sshd)
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

config_dir="${SSHD_CONFIG_DIR:-/etc/ssh/sshd_config.d}"
authorized_keys="${ROOT_AUTHORIZED_KEYS:-/root/.ssh/authorized_keys}"
run_dir="${SSHD_RUN_DIR:-/run/sshd}"
drop_in="$config_dir/10-nexus-ops-hardening.conf"

# One awk program rather than a grep pipeline, because pipefail would report SIGPIPE
# from the earlier stages as "no key". A forced command means the key only runs that
# command: cloud images ship root keys that just print "log in as ubuntu" and exit.
has_usable_key() {
  [ -r "$authorized_keys" ] || return 1
  # sshd ignores keys in a file or directory others can write to (StrictModes).
  [ -z "$(find "$authorized_keys" "$(dirname "$authorized_keys")" -maxdepth 0 -perm /022)" ] || return 1
  awk '
    /^[[:space:]]*(#|$)/ { next }
    /command=/ { next }
    /(^|[[:space:]])(ssh-(ed25519|rsa)|ecdsa-sha2-nistp[0-9]+|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)[[:space:]]+AAAA/ {
      found = 1
      exit
    }
    END { exit !found }
  ' "$authorized_keys"
}

if ! has_usable_key; then
  cat >&2 <<EOF
WARNING: SSH is unchanged. $authorized_keys has no key that can log in as root, so
turning off password login could lock you out. Add a key, confirm that logging in with
it works, then run $0 again.
EOF
  exit 0
fi

mkdir -p "$config_dir"
previous="$(cat "$drop_in" 2>/dev/null || true)"
cat >"$drop_in" <<'EOF'
# Managed by deployments/hybrid/vps/harden-ssh.sh.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
chmod 644 "$drop_in"

# Ubuntu's socket-activated sshd creates this only when the service runs.
[ -d "$run_dir" ] || install -d -m 0755 "$run_dir"
if ! sshd -t; then
  if [ -n "$previous" ]; then printf '%s\n' "$previous" >"$drop_in"; else rm -f "$drop_in"; fi
  echo "sshd rejected its configuration; SSH is unchanged." >&2
  exit 1
fi

# Does nothing if sshd is not running: it reads the new config when it next starts.
systemctl try-reload-or-restart ssh
echo "SSH: password login is off; root can log in with a key only."
