#!/usr/bin/env bash
# Tests backup.sh and restore.sh with a docker stub on PATH that stands in for Compose,
# the database, MinIO and rclone (using a local directory as the remote). It starts no
# containers and changes nothing outside a temporary directory.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vps="$here/../vps"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/rclone" "$work/stubdata"
echo data >"$work/stubdata/file"

cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Logs each call, one line each, then acts it out.
set -euo pipefail
printf 'docker %s\n' "$*" | tr '\n' ' ' >>"$STUB_DIR/calls"
echo >>"$STUB_DIR/calls"
remote="$STUB_DIR/remote"
mkdir -p "$remote"

valid_archive() { tar czf - -C "$STUB_DIR" stubdata; }

if [ "$1" = "compose" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in exec | ps | stop | up | restart | run | config) break ;; esac
    shift
  done
  subcommand="${1:-}"
  case "$subcommand" in
    ps) echo stub-container-id ;;
    exec)
      case "$3" in
        plane-db)
          case "$*" in
            *pg_dump*) [ -z "${STUB_DUMP_FAIL:-}" ] || exit 3; printf 'PGDMP stub dump' ;;
            *pg_restore*) cat >/dev/null ;;
          esac
          ;;
        agent-runner) valid_archive ;;
      esac
      ;;
    run) cat >/dev/null ;;
  esac
  exit 0
fi

# docker run
args=("$@")
stage=""
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    *:/stage:*) stage="${args[$i]%%:*}" ;;
    rclone/rclone:*)
      rest=("${args[@]:$((i + 1))}")
      case "${rest[0]}" in
        config) echo "type = crypt" ;;
        copy)
          source="${rest[1]}"; dest="${rest[2]}"; filter="${rest[3]:-}"
          if [ "$source" = "/stage" ]; then
            name="${dest#*:}"
            if [ -n "${STUB_UPLOAD_FAIL:-}" ] && [ "$filter" = "--exclude" ]; then
              # An upload that dies partway: some files arrive, then an error.
              mkdir -p "$remote/$name"
              cp "$stage/postgres.dump" "$remote/$name/"
              exit 9
            fi
            mkdir -p "$remote/$name"
            if [ "$filter" = "--exclude" ]; then
              find "$stage" -maxdepth 1 -type f ! -name SHA256SUMS -exec cp {} "$remote/$name/" \;
            else
              cp "$stage/SHA256SUMS" "$remote/$name/"
            fi
          else
            name="${source#*:}"
            cp -r "$remote/$name/." "$stage/"
          fi
          ;;
        delete) echo delete >>"$STUB_DIR/retention" ;;
        lsf)
          (cd "$remote" && find . -type f -name SHA256SUMS | sed 's#^\./##')
          ;;
      esac
      exit 0
      ;;
    alpine:*)
      if [ "${args[$((i + 1))]}" = "sh" ]; then cat >/dev/null; else valid_archive; fi
      exit 0
      ;;
  esac
done
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"
[ "$(command -v docker)" = "$work/bin/docker" ] || { echo "The docker stub is not first on PATH." >&2; exit 1; }

export STUB_DIR="$work"
export ENV_FILE="$work/env"
export RCLONE_CONFIG_DIR="$work/rclone"
export BACKUP_STAGING_DIR="$work/staging"
cat >"$ENV_FILE" <<'ENV'
BACKUP_REMOTE=crypt-test:
POSTGRES_USER=plane
ENV

status=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; status=1; }

reset() { rm -rf "$work/remote" "$work/retention" "$work/calls" "$work/staging"; }
stamps() { ls "$work/remote" 2>/dev/null || true; }
backup() { "$vps/backup.sh" >"$work/out" 2>&1; }

reset
if backup; then
  name="$(stamps)"
  if [ -f "$work/remote/$name/SHA256SUMS" ] && [ -f "$work/retention" ] && (cd "$work/remote/$name" && sha256sum -c SHA256SUMS >/dev/null); then
    pass "a backup uploads every file with valid checksums, then runs retention"
  else
    fail "a successful backup is missing files or retention did not run"
  fi
else
  fail "the backup failed: $(cat "$work/out")"
fi
if grep -F "$work/staging" "$work/calls" | grep -q ':/stage'; then
  pass "staging happens in BACKUP_STAGING_DIR, not /tmp"
else
  fail "staging did not use BACKUP_STAGING_DIR"
fi
if [ -z "$(ls -A "$work/staging")" ]; then
  pass "the staging directory is removed afterwards"
else
  fail "the staging directory was left behind"
fi
if grep -q 'BACKUP_STAGING_DIR:-/var/backups/nexus-ops' "$vps/backup.sh" && grep -q 'BACKUP_STAGING_DIR:-/var/backups/nexus-ops' "$vps/restore.sh"; then
  pass "staging defaults to the disk under /var/backups, not /tmp"
else
  fail "the staging default is not on disk"
fi

reset
if BACKUP_EXTRA_PATHS="$work/stubdata" backup; then
  name="$(stamps)"
  if grep -q extra.tar.gz "$work/remote/$name/SHA256SUMS" && tar tzf "$work/remote/$name/extra.tar.gz" | grep -q stubdata/file; then
    pass "extra paths are archived and checksummed"
  else
    fail "extra paths did not reach the backup"
  fi
else
  fail "a backup with extra paths failed: $(cat "$work/out")"
fi

reset
if BACKUP_EXTRA_PATHS="$work/does-not-exist" backup; then
  fail "a missing extra path did not fail the run"
elif [ -n "$(stamps)" ]; then
  fail "something was uploaded despite a missing extra path"
else
  pass "a missing extra path fails before anything is uploaded"
fi

reset
if STUB_DUMP_FAIL=1 backup; then
  fail "a failed database dump did not fail the run"
elif [ -n "$(stamps)" ] || [ -e "$work/retention" ]; then
  fail "a backup with a failed dump was uploaded or pruned"
elif grep -q FAILED "$work/out"; then
  pass "a failed database dump stops the backup loudly, and uploads nothing"
else
  fail "the failure was not reported clearly"
fi

reset
if STUB_UPLOAD_FAIL=1 backup; then
  fail "an upload that dies partway did not fail the run"
elif [ -e "$work/retention" ]; then
  fail "retention ran after a partial upload"
else
  name="$(stamps)"
  if [ -n "$name" ] && [ ! -e "$work/remote/$name/SHA256SUMS" ] && grep -q FAILED "$work/out"; then
    pass "an upload that dies partway fails loudly and leaves no completion marker"
  else
    fail "a partial upload was not reported as incomplete"
  fi
fi
listed="$("$vps/restore.sh" list)"
if [ -z "$listed" ]; then
  pass "restore.sh list does not offer the partial backup"
else
  fail "restore.sh list offered a partial backup: $listed"
fi

reset
backup
name="$(stamps)"
"$vps/restore.sh" list >"$work/listed"
if grep -qx "$name/" "$work/listed"; then
  pass "restore.sh list shows a complete backup"
else
  fail "a complete backup is not listed"
fi

: >"$work/calls"
if printf '%s\n' "$name" | "$vps/restore.sh" restore "$name" >"$work/out" 2>&1; then
  pass "a restore runs to the end"
else
  fail "the restore failed: $(cat "$work/out")"
fi
line_of() { grep -nF -- "$1" "$work/calls" | head -n 1 | cut -d: -f1 || true; }
stop_line="$(line_of 'stop gateway agent-bridge agent-runner')"
stops_datastores=0
grep -F 'stop gateway agent-bridge agent-runner' "$work/calls" | grep -q 'worker beat-worker' \
  && grep -F 'stop gateway agent-bridge agent-runner' "$work/calls" | grep -q 'plane-redis plane-mq' && stops_datastores=1
pgrestore_line="$(line_of 'pg_restore')"
flush_line="$(line_of 'FLUSHALL')"
vhost_line="$(line_of 'delete_vhost')"
up_line="$(grep -nxE 'docker compose .* up -d *' "$work/calls" | tail -n 1 | cut -d: -f1 || true)"
if [ "$stops_datastores" -eq 1 ] && [ "$stop_line" -lt "$pgrestore_line" ]; then
  pass "workers, Valkey and RabbitMQ are stopped before the data is replaced"
else
  fail "consumers were not stopped before the restore"
fi
if [ "$pgrestore_line" -lt "$flush_line" ] && [ "$pgrestore_line" -lt "$vhost_line" ] \
  && [ "$flush_line" -lt "$up_line" ] && [ "$vhost_line" -lt "$up_line" ]; then
  pass "Valkey and the queues are emptied after the data is restored, before anything restarts"
else
  fail "Valkey and the queues are not emptied before services restart"
fi
if grep -nE 'up -d.*(worker|api|beat-worker)' "$work/calls" | grep -v 'up -d *$' >/dev/null; then
  fail "a worker was started before the queues were emptied"
else
  pass "no worker starts before the final start of the whole stack"
fi

reset
if BACKUP_WORKSPACES_MAX_BYTES=1 backup; then
  fail "an oversized workspaces archive did not fail the run"
else
  name="$(stamps)"
  if [ -f "$work/remote/$name/WORKSPACES_OMITTED" ] && [ ! -e "$work/remote/$name/agent_workspaces.tar.gz" ] \
    && [ "$("$vps/restore.sh" list)" = "$name/" ]; then
    pass "a backup without its oversized workspaces is uploaded with a marker and is listed"
  else
    fail "the marker or the listing is wrong for an oversized backup: $(cat "$work/out")"
  fi
  : >"$work/calls"
  if printf '%s\n' "$name" | "$vps/restore.sh" restore "$name" >"$work/out" 2>&1 \
    && grep -q 'left out because the archive was too large' "$work/out" \
    && ! grep -q 'entrypoint sh agent-runner' "$work/calls"; then
    pass "a restore says the workspaces were left out and leaves the volume alone"
  else
    fail "the restore did not report the omitted workspaces: $(cat "$work/out")"
  fi
fi

exit "$status"
