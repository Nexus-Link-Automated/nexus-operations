#!/usr/bin/env bash
# Keeps the agents off everything but the public internet. Agents in agent-runner run
# arbitrary shell commands, and the `agents` Docker network has outbound internet,
# which would otherwise also reach:
#   - other devices on the tailnet, as this VPS (Docker masquerades out tailscale0);
#   - the cloud provider's metadata service and private networks;
#   - this host itself (ufw allows SSH from anywhere).
# Traffic between containers on the `agents` network (agent-bridge <-> agent-runner,
# agent-runner -> mcp) is unaffected.
#
#   agents-firewall.sh            apply the rules
#   agents-firewall.sh --verify   re-apply them only if the live rules differ
#
# Changes are atomic. The rules are built in new chains that nothing jumps to yet, the
# jumps are moved over (each new jump goes in before its old one is removed), and only
# then are the old chains deleted, so a chain with holes in it never filters traffic.
#
# The jump is also the first rule of FORWARD. Tailscale's ts-forward chain accepts
# tailnet-bound traffic and can sit above DOCKER-USER, so DOCKER-USER alone is not
# enough; Docker and Tailscale put their own rules back on top when they restart, which
# is why bootstrap.sh runs --verify on a timer as well as re-applying when Docker starts.
#
# Docker never flushes DOCKER-USER, so these rules survive container restarts.
# Safe to run again. Run as root.
set -euo pipefail

case "${1:-}" in
  "") mode=apply ;;
  --verify) mode=verify ;;
  *) echo "usage: $0 [--verify]" >&2; exit 2 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
env_file="${ENV_FILE:-$here/.env}"
bridge="${AGENTS_BRIDGE_NAME:-}"
if [ -z "$bridge" ] && [ -r "$env_file" ]; then
  bridge="$(sed -n 's/^AGENTS_BRIDGE_NAME=//p' "$env_file" | tail -n 1)"
fi
bridge="${bridge:-br-nexus-agents}"

forward_chain=NEXUS-AGENTS-FWD
input_chain=NEXUS-AGENTS-IN

# One run at a time: the timer and the Docker-triggered unit can start together.
exec 9>"${AGENTS_FIREWALL_LOCK:-/run/nexus-ops-agents-firewall.lock}"
flock -w 60 9

# -w waits for the xtables lock, which Docker and Tailscale hold while they make changes.
ipt() { iptables -w "$@"; }

# Each rule exactly as `iptables -S` prints it, so these lists work for applying and
# for comparing against the live chains.
forward_rules() {
  local range
  # Leaving the agents network, towards anything that is not the public internet.
  echo "-o $bridge -j RETURN"
  echo "-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  # Docker's embedded DNS forwards queries to the host's resolvers, which can sit on a
  # private or link-local address.
  echo "-p udp -m udp --dport 53 -j RETURN"
  echo "-p tcp -m tcp --dport 53 -j RETURN"
  echo "-o tailscale+ -j REJECT --reject-with icmp-admin-prohibited"
  for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
    192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
    echo "-d $range -j REJECT --reject-with icmp-admin-prohibited"
  done
  echo "-j RETURN"
}

# To the host itself: nothing an agent needs.
input_rules() {
  echo "-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  echo "-j REJECT --reject-with icmp-admin-prohibited"
}

# Every chain this script owns, under any name a run may have left behind.
agent_chains() {
  ipt -S | sed -n 's/^-N \(NEXUS-AGENTS-.*\)$/\1/p'
}

build_chain() {
  local chain="$1" rules="$2" line
  local -a rule
  ipt -N "$chain"
  while IFS= read -r line; do
    read -r -a rule <<<"$line"
    ipt -A "$chain" "${rule[@]}"
  done < <("$rules")
}

# Puts a jump to $new_chain on top of $hook, then removes the jumps to old chains.
move_jumps() {
  local hook="$1" new_chain="$2" old
  ipt -I "$hook" 1 -i "$bridge" -j "$new_chain"
  for old in "${old_chains[@]}"; do
    while ipt -D "$hook" -i "$bridge" -j "$old" 2>/dev/null; do :; done
  done
}

apply() {
  local new_forward="$forward_chain-$$" new_input="$input_chain-$$" chain
  local -a old_chains
  mapfile -t old_chains < <(agent_chains)

  # Docker creates DOCKER-USER on start; create it too, so the order does not matter.
  ipt -N DOCKER-USER 2>/dev/null || true

  build_chain "$new_forward" forward_rules
  build_chain "$new_input" input_rules

  # DOCKER-USER stays jumped too: it covers traffic in the moments after Docker restarts
  # and moves its own jumps above ours, until the check timer puts ours back on top.
  move_jumps FORWARD "$new_forward"
  move_jumps DOCKER-USER "$new_forward"
  move_jumps INPUT "$new_input"

  for chain in "${old_chains[@]}"; do
    ipt -F "$chain"
    ipt -X "$chain"
  done
  # Only the name changes; the jumps keep pointing at the same chains.
  ipt -E "$new_forward" "$forward_chain"
  ipt -E "$new_input" "$input_chain"

  echo "Agent network firewall applied to $bridge."
}

# Matches when the live chain holds exactly these rules, in this order.
chain_matches() {
  local chain="$1" rules="$2"
  [ "$(ipt -S "$chain" 2>/dev/null | sed -n "s/^-A $chain //p")" = "$("$rules")" ]
}

# Matches when $hook's first rule is the jump to $target and it is the only such jump.
jump_is_first() {
  local hook="$1" target="$2" jump rules
  jump="-A $hook -i $bridge -j $target"
  rules="$(ipt -S "$hook" 2>/dev/null | sed -n '/^-A /p')"
  [ "$(printf '%s\n' "$rules" | head -n 1)" = "$jump" ] \
    && [ "$(printf '%s\n' "$rules" | grep -cxF -- "$jump")" -eq 1 ]
}

verify() {
  local problem=""
  if ! chain_matches "$forward_chain" forward_rules; then
    problem="$forward_chain does not hold the expected rules"
  elif ! chain_matches "$input_chain" input_rules; then
    problem="$input_chain does not hold the expected rules"
  elif ! jump_is_first FORWARD "$forward_chain"; then
    problem="the jump to $forward_chain is not the first rule of FORWARD"
  elif ! jump_is_first DOCKER-USER "$forward_chain"; then
    problem="the jump to $forward_chain is not the first rule of DOCKER-USER"
  elif ! jump_is_first INPUT "$input_chain"; then
    problem="the jump to $input_chain is not the first rule of INPUT"
  elif [ "$(agent_chains | wc -l)" -ne 2 ]; then
    problem="chains from an interrupted run are still present"
  fi
  if [ -n "$problem" ]; then
    echo "Agent network firewall drifted ($problem); re-applying." >&2
    apply
  fi
}

"$mode"
