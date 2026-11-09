#!/usr/bin/env bash
# Sends an encrypted backup off the server: the Postgres dump, the uploads volume,
# the agents' working dirs (agent_workspaces) and .env. The .env copy matters because Plane encrypts stored instance settings
# with SECRET_KEY, so a database restored without it loses those settings.
#
# Settings, from the environment or .env (except ENV_FILE):
#   BACKUP_REMOTE          rclone crypt remote to upload to (required)
#   BACKUP_RETENTION_DAYS  delete backups older than this after a good run (default: 30)
#   BACKUP_STAGING_DIR     where the backup is put together, which needs room for a full
#                          backup: not /tmp, often a small tmpfs (default: /var/backups/nexus-ops)
#   BACKUP_EXTRA_PATHS     more host paths to include, such as deployment config
#                          (space-separated, relative to this directory; optional)
#   BACKUP_WORKSPACES_MAX_BYTES  cap on the agents' working dirs archive (default: 20 GiB).
#                          An archive over it is left out, a WORKSPACES_OMITTED file in the
#                          backup says so, and the run exits with an error, so one agent's
#                          files can neither fill the staging disk nor stop the database
#                          being backed up.
#   ENV_FILE               env file to read (default: ./.env)
#   COMPOSE_FILES          compose arguments (default: -f docker-compose.yml)
#   COMPOSE_PROJECT        compose project name (default: the file's own)
#   RCLONE_CONFIG_DIR      directory holding rclone.conf (default: ./rclone)
#   RCLONE_EXTRA_MOUNT     extra docker volume for rclone, for a local test remote
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

env_file="${ENV_FILE:-$here/.env}"
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

: "${BACKUP_REMOTE:?BACKUP_REMOTE is not set}"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
workspaces_max_bytes="${BACKUP_WORKSPACES_MAX_BYTES:-$((20 * 1024 * 1024 * 1024))}"
staging_root="${BACKUP_STAGING_DIR:-/var/backups/nexus-ops}"
read -r -a extra_paths <<<"${BACKUP_EXTRA_PATHS:-}"
rclone_config_dir="${RCLONE_CONFIG_DIR:-$here/rclone}"
rclone_image="rclone/rclone:1.75.2"
read -r -a compose_files <<<"${COMPOSE_FILES:--f docker-compose.yml}"

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

# These backups include every secret in .env, so plain storage is not acceptable.
remote_name="${BACKUP_REMOTE%%:*}"
remote_type="$(rclone config show "$remote_name" | awk -F' *= *' '$1 == "type" { print $2 }')"
if [ "$remote_type" != "crypt" ]; then
  echo "BACKUP_REMOTE must be an rclone crypt remote; '$remote_name' has type '${remote_type:-unknown}'." >&2
  exit 1
fi

for path in "${extra_paths[@]}"; do
  [ -e "$path" ] || { echo "BACKUP_EXTRA_PATHS: $path does not exist." >&2; exit 1; }
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$staging_root"
# A run that was killed leaves its directory behind, and this disk is not cleared at reboot.
find "$staging_root" -mindepth 1 -maxdepth 1 -name 'backup.*' -mtime +0 -exec rm -rf {} +
stage="$(mktemp -d "$staging_root/backup.XXXXXX")"
finish() {
  local status=$?
  rm -rf "$stage"
  if [ "$status" -ne 0 ]; then
    echo "Backup $stamp FAILED (exit $status). It is not complete, and retention did not run." >&2
  fi
}
trap finish EXIT
chmod 700 "$stage"

compose exec -T plane-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$stage/postgres.dump"
minio_container="$(compose ps -q plane-minio)"
[ -n "$minio_container" ] || { echo "plane-minio is not running." >&2; exit 1; }
docker run --rm --volumes-from "$minio_container:ro" alpine:3.22 tar czf - -C /export . >"$stage/uploads.tar.gz"

# Every working dir belongs to its own uid, so the archive keeps numeric owners and
# modes (GNU tar from the runner image). Agents may be writing meanwhile: a file that
# changes while it is read is not an error (tar exit status 1). .tmp is scratch space.
# --sparse stores a sparse file's holes as holes, so its apparent size costs nothing.
# head reads one byte past the cap, so an archive that big is told apart from one that fits.
[ -n "$(compose ps -q agent-runner)" ] || { echo "agent-runner is not running." >&2; exit 1; }
workspaces_status=0
compose exec -T agent-runner sh -c \
  'tar --sparse --numeric-owner --warning=no-file-changed --exclude=./.tmp -czf - -C "$AGENT_WORKSPACES_ROOT" . || [ $? -eq 1 ]' \
  | head -c "$((workspaces_max_bytes + 1))" >"$stage/agent_workspaces.tar.gz" || workspaces_status=$?
workspaces_oversized=0
if [ "$(stat -c %s "$stage/agent_workspaces.tar.gz")" -gt "$workspaces_max_bytes" ]; then
  rm "$stage/agent_workspaces.tar.gz"
  workspaces_oversized=1
elif [ "$workspaces_status" -ne 0 ]; then
  echo "The agent workspaces archive failed." >&2
  exit 1
fi
cp "$env_file" "$stage/env"
if [ "${#extra_paths[@]}" -gt 0 ]; then
  tar czPf "$stage/extra.tar.gz" "${extra_paths[@]}"
fi

# A failed or empty dump must not replace good history through the retention step.
[ -s "$stage/postgres.dump" ] || { echo "Postgres dump is empty." >&2; exit 1; }
tar tzf "$stage/uploads.tar.gz" >/dev/null
checksummed=(postgres.dump uploads.tar.gz env)
if [ "$workspaces_oversized" -eq 1 ]; then
  # So that a restore can tell this from a backup made before the agent chat.
  echo "The agent workspaces archive passed BACKUP_WORKSPACES_MAX_BYTES ($workspaces_max_bytes bytes) and was left out of this backup." >"$stage/WORKSPACES_OMITTED"
  checksummed+=(WORKSPACES_OMITTED)
else
  tar tzf "$stage/agent_workspaces.tar.gz" >/dev/null
  checksummed+=(agent_workspaces.tar.gz)
fi
[ "${#extra_paths[@]}" -eq 0 ] || checksummed+=(extra.tar.gz)
(cd "$stage" && sha256sum "${checksummed[@]}") >"$stage/SHA256SUMS"

# The checksums go last: their presence marks a backup as complete, so an upload that
# dies partway leaves a directory that restore.sh does not offer.
RCLONE_DATA_MOUNT="$stage:/stage:ro,z" rclone copy /stage "${BACKUP_REMOTE}${stamp}" --exclude SHA256SUMS
RCLONE_DATA_MOUNT="$stage:/stage:ro,z" rclone copy /stage "${BACKUP_REMOTE}${stamp}" --include SHA256SUMS
if [ "$workspaces_oversized" -eq 1 ]; then
  # Retention is skipped too: this backup is missing the workspaces older ones have.
  echo "Backup $stamp has no agent workspaces: the archive passed BACKUP_WORKSPACES_MAX_BYTES ($workspaces_max_bytes bytes)." >&2
  exit 1
fi
rclone delete "${BACKUP_REMOTE}" --min-age "${retention_days}d"
rclone rmdirs "${BACKUP_REMOTE}" --leave-root

echo "Backup $stamp uploaded to $BACKUP_REMOTE"
