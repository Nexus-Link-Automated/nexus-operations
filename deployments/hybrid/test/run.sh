#!/usr/bin/env bash
# Brings up the full hybrid topology locally and runs the smoke checks against it.
# Uses the official images for APP_RELEASE (default v1.4.3), so nothing has to be
# built. Pass --keep to leave the stack running afterwards.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vps="$here/../vps"
project="nexus-hybrid-test"
keep=0
[ "${1:-}" = "--keep" ] && keep=1

work="$(mktemp -d /tmp/nexus-hybrid-test.XXXXXX)"
export TEST_ROUTER_PORT="${TEST_ROUTER_PORT:-18080}"
export TEST_GATEWAY_PORT="${TEST_GATEWAY_PORT:-18081}"

cat >"$work/.env" <<EOF
APP_DOMAIN=operations.nexus-test.invalid
IMAGE_REGISTRY=${IMAGE_REGISTRY:-makeplane}
APP_RELEASE=${APP_RELEASE:-v1.4.3}
POSTGRES_PASSWORD=$(openssl rand -hex 16)
RABBITMQ_PASSWORD=$(openssl rand -hex 16)
AWS_ACCESS_KEY_ID=$(openssl rand -hex 16)
AWS_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
SECRET_KEY=$(openssl rand -hex 32)
LIVE_SERVER_SECRET_KEY=$(openssl rand -hex 32)
EOF

compose() {
  docker compose -p "$project" --env-file "$work/.env" \
    -f "$vps/docker-compose.yml" -f "$here/docker-compose.override.yml" "$@"
}

cleanup() {
  if [ "$keep" -eq 1 ]; then
    echo "Stack left running as project $project; router on 127.0.0.1:$TEST_ROUTER_PORT."
    echo "Env file: $work/.env"
    return
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

compose up -d --build

url="http://127.0.0.1:$TEST_ROUTER_PORT"
echo "Waiting for the API to answer through the router..."
ready=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/api/instances/" || true)" = "200" ]; then
    ready=1
    break
  fi
  sleep 5
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL  the API never answered through the router" >&2
  compose ps -a >&2
  compose logs --tail 20 router socks gateway api >&2 || true
  exit 1
fi

status=0
python3 "$here/smoke.py" --public-url https://operations.nexus-test.invalid --connect-url "$url" --write || status=$?

# With no direct route, passing the checks above proves the proxy path was used.
if compose exec -T router wget -q -T 3 -O /dev/null http://gateway/__gateway/health >/dev/null 2>&1; then
  echo "FAIL  the router can reach the gateway without the proxy"
  status=1
else
  echo "PASS  the router reaches the gateway only through the proxy"
fi

published="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}} {{.Ports}}' \
  | grep -E '0\.0\.0\.0|:::' || true)"
if [ -z "$published" ]; then
  echo "PASS  no service publishes a port beyond loopback"
else
  echo "FAIL  ports open beyond loopback: $published"
  status=1
fi

if [ "$status" -ne 0 ]; then
  compose logs --tail 40 gateway api router socks >&2 || true
fi
exit "$status"
