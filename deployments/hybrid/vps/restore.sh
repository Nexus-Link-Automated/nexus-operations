#!/usr/bin/env bash
# Restores or verifies a backup made by backup.sh.
#
#   restore.sh list                 show available backups
#   restore.sh verify <backup>      restore into a throwaway database; touches nothing live
#   restore.sh restore <backup>     REPLACE live data; asks for confirmation
#
# Reads the same settings as backup.sh: ENV_FILE, BACKUP_REMOTE, BACKUP_STAGING_DIR,
# COMPOSE_FILES, COMPOSE_PROJECT and RCLONE_CONFIG_DIR.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

env_file="${ENV_FILE:-$here/.env}"
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

: "${BACKUP_REMOTE:?BACKUP_REMOTE is not set}"
staging_root="${BACKUP_STAGING_DIR:-/var/backups/nexus-ops}"
rclone_config_dir="${RCLONE_CONFIG_DIR:-$here/rclone}"
rclone_image="rclone/rclone:1.75.2"
read -r -a compose_files <<<"${COMPOSE_FILES:--f docker-compose.yml}"
app_services=(gateway agent-bridge agent-runner mcp api worker beat-worker live space admin)

compose() {
  docker compose ${COMPOSE_PROJECT:+-p "$COMPOSE_PROJECT"} --env-file "$env_file" "${compose_files[@]}" "$@"
}

rclone() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$rclone_config_dir:/config/rclone:ro,z" \
    ${RCLONE_DATA_MOUNT:+-v "$RCLONE_DATA_MOUNT"} \
    ${RCLONE_EXTRA_MOUNT:+-v "$RCLONE_EXTRA_MOUNT"} \
    "$rclone_image" "$@"
}

# The postgres image starts a temporary server on the Unix socket only while it
# initialises a new data directory, then restarts. A socket check can pass against
# that temporary server, so readiness is checked over TCP, which it never listens on.
wait_for_postgres() {
  local exec_cmd=("$@")
  for _ in $(seq 1 90); do
    "${exec_cmd[@]}" sh -c 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "Postgres did not become ready." >&2
  return 1
}

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

action="${1:-}"
backup="${2:-}"

if [ "$action" = "list" ]; then
  # Only finished backups: backup.sh uploads SHA256SUMS last.
  rclone lsf -R --files-only --include SHA256SUMS "$BACKUP_REMOTE" | sed 's#/SHA256SUMS$#/#' | sort
  exit 0
fi
case "$action" in verify | restore) ;; *) usage ;; esac
[ -n "$backup" ] || usage
backup="${backup%/}"

install -d -m 700 "$staging_root"
stage="$(mktemp -d "$staging_root/restore.XXXXXX")"
chmod 700 "$stage"
scratch_container=""
cleanup() {
  [ -z "$scratch_container" ] || docker rm -f "$scratch_container" >/dev/null 2>&1 || true
  rm -rf "$stage"
}
trap cleanup EXIT

RCLONE_DATA_MOUNT="$stage:/stage:z" rclone copy "${BACKUP_REMOTE}${backup}" /stage
[ -e "$stage/SHA256SUMS" ] || { echo "Backup $backup is incomplete: its upload did not finish." >&2; exit 1; }
(cd "$stage" && sha256sum -c SHA256SUMS)
tar tzf "$stage/uploads.tar.gz" >/dev/null
# Backups made before the agent chat have no agent_workspaces archive, and backup.sh
# leaves out one that is too large, recording that in WORKSPACES_OMITTED.
has_agent_workspaces=0
no_workspaces_reason="made before the agent chat"
if [ -e "$stage/agent_workspaces.tar.gz" ]; then
  tar tzf "$stage/agent_workspaces.tar.gz" >/dev/null
  has_agent_workspaces=1
elif [ -e "$stage/WORKSPACES_OMITTED" ]; then
  no_workspaces_reason="left out because the archive was too large"
fi
echo "Checksums and the archives are good."

if [ "$action" = "verify" ]; then
  # The same image as the live database, because pg_restore cannot read a dump
  # made by a newer major version.
  postgres_image="$(compose config --images plane-db)"
  [ -n "$postgres_image" ] || { echo "Could not read the plane-db image from the compose file." >&2; exit 1; }
  scratch_container="nexus-ops-restore-verify-$$"
  docker run -d --name "$scratch_container" \
    -e POSTGRES_USER=plane -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=plane \
    "$postgres_image" >/dev/null
  wait_for_postgres docker exec "$scratch_container"
  docker exec -i "$scratch_container" pg_restore -U plane -d plane --no-owner --no-acl --exit-on-error <"$stage/postgres.dump"
  tables="$(docker exec "$scratch_container" psql -U plane -d plane -Atc \
    "select count(*) from information_schema.tables where table_schema = 'public'")"
  users="$(docker exec "$scratch_container" psql -U plane -d plane -Atc 'select count(*) from users')"
  migrations="$(docker exec "$scratch_container" psql -U plane -d plane -Atc 'select count(*) from django_migrations')"
  objects="$(tar tzf "$stage/uploads.tar.gz" | grep -c . || true)"
  echo "Restored into a scratch database: $tables tables, $migrations migrations, $users users; uploads archive has $objects entries."
  if [ "$has_agent_workspaces" -eq 1 ]; then
    echo "Agent workspaces archive has $(tar tzf "$stage/agent_workspaces.tar.gz" | grep -c . || true) entries."
  else
    echo "This backup has no agent workspaces archive ($no_workspaces_reason)."
  fi
  [ "$tables" -gt 0 ] && [ "$migrations" -gt 0 ] || { echo "The restored database looks empty." >&2; exit 1; }
  echo "Verified: $backup"
  exit 0
fi

echo "This REPLACES the live database and uploads with backup $backup, and empties Valkey and the task queues."
[ "$has_agent_workspaces" -eq 1 ] || echo "This backup has no agent workspaces archive ($no_workspaces_reason); agent_workspaces will be left as it is."
read -r -p "Type the backup name to continue: " confirmation
[ "$confirmation" = "$backup" ] || { echo "Cancelled; nothing changed." >&2; exit 1; }

# The API, workers and live server must not write while data is being replaced. Valkey
# and RabbitMQ go down with them, and stay down until they are emptied below.
compose stop "${app_services[@]}" plane-redis plane-mq
compose up -d --wait plane-db plane-minio
wait_for_postgres compose exec -T plane-db

compose exec -T plane-db sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "drop database if exists \"$POSTGRES_DB\" with (force)" \
  -c "create database \"$POSTGRES_DB\" owner \"$POSTGRES_USER\""'
compose exec -T plane-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' <"$stage/postgres.dump"

minio_container="$(compose ps -q plane-minio)"
docker run --rm -i --volumes-from "$minio_container" alpine:3.22 \
  sh -c 'find /export -mindepth 1 -delete && tar xzf - -C /export' <"$stage/uploads.tar.gz"
compose restart plane-minio

if [ "$has_agent_workspaces" -eq 1 ]; then
  # In a one-off runner container (the runner itself is stopped), so GNU tar restores
  # each dir's numeric owner and mode.
  compose run --rm -T --no-deps --entrypoint sh agent-runner -c \
    'find "$AGENT_WORKSPACES_ROOT" -mindepth 1 -delete && tar --numeric-owner -xpzf - -C "$AGENT_WORKSPACES_ROOT"' \
    <"$stage/agent_workspaces.tar.gz"
else
  echo "This backup has no agent workspaces archive; agent_workspaces is left as it is."
fi

# Tasks queued before the restore refer to data that may no longer exist, and Valkey
# caches state from the same past, so both are emptied before anything can consume them.
# Deleting the vhost removes every queue at once; the workers declare theirs on start.
compose up -d --wait plane-redis plane-mq
compose exec -T plane-redis valkey-cli FLUSHALL
compose exec -T plane-mq sh -c 'rabbitmqctl delete_vhost "$RABBITMQ_DEFAULT_VHOST" \
  && rabbitmqctl add_vhost "$RABBITMQ_DEFAULT_VHOST" \
  && rabbitmqctl set_permissions -p "$RABBITMQ_DEFAULT_VHOST" "$RABBITMQ_DEFAULT_USER" ".*" ".*" ".*"'

compose up -d
echo "Restored $backup. The .env from that backup is not applied automatically:"
echo "compare it with the live .env if the secrets may have changed."
