#!/usr/bin/env bash
# Tests agents-firewall.sh against the iptables stub in stubs/, on PATH. It never runs
# the real iptables, so it is safe on any machine and needs no root.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${FIREWALL_SCRIPT:-$here/../vps/agents-firewall.sh}"
bootstrap="$here/../vps/bootstrap.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cp "$here/stubs/iptables" "$work/bin/iptables"
printf '#!/bin/sh\necho 0\n' >"$work/bin/id"
chmod +x "$work/bin"/*

export PATH="$work/bin:$PATH"
[ "$(command -v iptables)" = "$work/bin/iptables" ] || { echo "The iptables stub is not first on PATH." >&2; exit 1; }
export AGENTS_FIREWALL_LOCK="$work/lock"
export AGENTS_BRIDGE_NAME=br-test
export ENV_FILE="$work/no-env"
export IPTABLES_STUB_DIR

status=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; status=1; }

new_state() {
  IPTABLES_STUB_DIR="$work/state-$1"
  mkdir -p "$IPTABLES_STUB_DIR"
  # Docker and Tailscale, as they would be found on a running host.
  iptables -N DOCKER-USER
  iptables -N ts-forward
  iptables -A ts-forward -o tailscale0 -j ACCEPT
  iptables -A FORWARD -j DOCKER-USER
  iptables -A FORWARD -j ts-forward
}

firewall() { "$script" "$@"; }

mutations() { ls "$IPTABLES_STUB_DIR/history" | wc -l; }

# True when a snapshot has $hook jumping from the bridge to a chain named after
# $family whose rules are exactly $expected.
hook_enforced() {
  local snapshot="$1" hook="$2" family="$3" expected="$4" target actual
  target="$(sed -n "s/^-A $hook -i br-test -j \($family.*\)$/\1/p" "$snapshot" | head -n 1)"
  [ -n "$target" ] || return 1
  actual="$(sed -n "s/^-A $target //p" "$snapshot")"
  [ "$actual" = "$expected" ]
}

# Checks every snapshot taken since mutation number $1.
enforced_throughout() {
  local from="$1" count snapshot failed=0
  local expected_fwd expected_in
  expected_fwd="$(sed -n 's/^-A NEXUS-AGENTS-FWD //p' "$IPTABLES_STUB_DIR/history/$(ls "$IPTABLES_STUB_DIR/history" | tail -n 1)")"
  expected_in="$(sed -n 's/^-A NEXUS-AGENTS-IN //p' "$IPTABLES_STUB_DIR/history/$(ls "$IPTABLES_STUB_DIR/history" | tail -n 1)")"
  count=0
  for snapshot in "$IPTABLES_STUB_DIR"/history/*; do
    count=$((count + 1))
    [ "$count" -gt "$from" ] || continue
    if ! hook_enforced "$snapshot" FORWARD NEXUS-AGENTS-FWD "$expected_fwd" \
      || ! hook_enforced "$snapshot" DOCKER-USER NEXUS-AGENTS-FWD "$expected_fwd" \
      || ! hook_enforced "$snapshot" INPUT NEXUS-AGENTS-IN "$expected_in"; then
      echo "        open at step $(basename "$snapshot"): $(head -n 1 "$snapshot")"
      failed=1
    fi
  done
  [ "$failed" -eq 0 ]
}

forward_first() {
  [ "$(iptables -S FORWARD | sed -n 's/^-A //p' | head -n 1)" = "FORWARD -i br-test -j NEXUS-AGENTS-FWD" ]
}

fingerprint() { iptables -S; }

new_state apply
firewall >/dev/null
reference="$(fingerprint)"

if forward_first; then pass "applying puts the jump first in FORWARD, ahead of ts-forward"; else fail "applying did not put the jump first in FORWARD"; fi
if [ "$(iptables -S DOCKER-USER | grep -c '^-A DOCKER-USER -i br-test -j NEXUS-AGENTS-FWD$')" -eq 1 ]; then
  pass "DOCKER-USER jumps to the agent chain once"
else
  fail "DOCKER-USER is missing the agent jump"
fi
if [ "$(iptables -S INPUT | sed -n 2p)" = "-A INPUT -i br-test -j NEXUS-AGENTS-IN" ]; then
  pass "INPUT jumps to the agent input chain first"
else
  fail "INPUT is missing the agent jump"
fi
if iptables -S NEXUS-AGENTS-FWD | grep -q -- '-d 169.254.0.0/16 -j REJECT' \
  && iptables -S NEXUS-AGENTS-IN | grep -q -- '-j REJECT'; then
  pass "the reject rules are in the chains"
else
  fail "the reject rules are missing"
fi

new_state reapply
firewall >/dev/null
from="$(mutations)"
firewall >/dev/null
if enforced_throughout "$from"; then
  pass "re-applying never leaves a hook without a complete chain"
else
  fail "re-applying left the firewall open between steps"
fi
if [ "$(fingerprint)" = "$reference" ]; then
  pass "re-applying ends with the same rules as the first apply"
else
  fail "re-applying changed the final rules"
fi

new_state verify-clean
firewall >/dev/null
from="$(mutations)"
if firewall --verify >/dev/null && [ "$(mutations)" -eq "$from" ]; then
  pass "--verify changes nothing when the rules are in place"
else
  fail "--verify touched a firewall that had not drifted"
fi

# The rules this script owns; other tools' rules may legitimately change order.
agent_rules() { iptables -S | grep -E 'NEXUS-AGENTS' | grep -vE '^-A (DOCKER-USER|FORWARD|INPUT) '; jump_positions; }
jump_positions() { forward_first && echo "forward-first"; iptables -S DOCKER-USER | grep -c NEXUS-AGENTS-FWD; iptables -S INPUT | grep -c NEXUS-AGENTS-IN; }
reference_rules="$(agent_rules)"

drift_case() {
  local name="$1"
  shift
  new_state "$name"
  firewall >/dev/null
  "$@"
  local from_mutations
  from_mutations="$(mutations)"
  if firewall --verify >/dev/null 2>&1; then :; else fail "--verify failed after: $name"; return; fi
  if [ "$(agent_rules)" = "$reference_rules" ] && [ "$(mutations)" -gt "$from_mutations" ]; then
    pass "--verify repairs: $name"
  else
    fail "--verify did not repair: $name"
  fi
}

drift_case "a reject rule removed" iptables -D NEXUS-AGENTS-FWD -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
drift_case "an extra accept rule added" iptables -I NEXUS-AGENTS-FWD 1 -j ACCEPT
ts_forward_on_top() { iptables -D FORWARD -j ts-forward; iptables -I FORWARD 1 -j ts-forward; }
drift_case "ts-forward back on top of FORWARD" ts_forward_on_top
drift_case "the FORWARD jump removed" iptables -D FORWARD -i br-test -j NEXUS-AGENTS-FWD
drift_case "the input chain flushed" iptables -F NEXUS-AGENTS-IN

new_state drift-window
firewall >/dev/null
ts_forward_on_top
from="$(mutations)"
firewall --verify >/dev/null 2>&1
if enforced_throughout "$from"; then
  pass "repairing never opens the firewall"
else
  fail "repairing left the firewall open between steps"
fi

new_state interrupted
firewall >/dev/null
iptables -N NEXUS-AGENTS-FWD-99999
if firewall --verify >/dev/null 2>&1 && [ "$(fingerprint)" = "$reference" ]; then
  pass "--verify cleans up chains left by an interrupted run"
else
  fail "--verify left an interrupted run's chains"
fi

new_state interrupted-live
firewall >/dev/null
iptables -E NEXUS-AGENTS-FWD NEXUS-AGENTS-FWD-99999
if firewall --verify >/dev/null 2>&1 && [ "$(fingerprint)" = "$reference" ] && forward_first; then
  pass "--verify recovers when an interrupted run left the rules in a differently named chain"
else
  fail "--verify did not recover from an interrupted run's renamed chain"
fi

if grep -q 'agents-firewall.sh --verify' "$bootstrap" && grep -q 'enable --now nexus-ops-agents-firewall-check.timer' "$bootstrap"; then
  pass "bootstrap installs the verify timer"
else
  fail "bootstrap does not run --verify on a timer"
fi

exit "$status"
