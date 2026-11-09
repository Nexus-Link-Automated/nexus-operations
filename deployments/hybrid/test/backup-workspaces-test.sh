#!/usr/bin/env bash
# Tests how backup.sh archives the agents' workspaces, with a docker stub on PATH that
# stands in for Compose, the runner's tar, and rclone. It starts no containers.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../vps/backup.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/rclone"
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
# compose <flags...> <subcommand> ...  and  run ... <image> ...
set -euo pipefail
echo "docker $*" >>"$STUB_DIR/calls"

valid_archive() { tar czf - -C "$STUB_DIR" stubdata; }

if [ "$1" = "compose" ]; then
  while [ "$1" != "exec" ] && [ "$1" != "ps" ]; do shift; done
  case "$1" in
    ps) echo "stub-container-id" ;;
    exec)
      case "$3" in
        plane-db) printf 'PGDMP stub dump' ;;
        agent-runner)
          printf '%s\n' "$6" >"$STUB_DIR/runner-command"
          if [ -n "${STUB_RUNNER_STATUS:-}" ]; then exit "$STUB_RUNNER_STATUS"; fi
          if [ -n "${STUB_RUNNER_BYTES:-}" ]; then
            head -c "$STUB_RUNNER_BYTES" /dev/urandom
          else
            valid_archive
          fi
          ;;
      esac
      ;;
  esac
  exit 0
fi

# docker run: find the rclone call, if this is one.
stage=""
args=("$@")
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    *:/stage:*) stage="${args[$i]%%:*}" ;;
    rclone/rclone:*)
      rest=("${args[@]:$((i + 1))}")
      case "${rest[0]}" in
        config) echo "type = crypt" ;;
        copy)
          # backup.sh uploads in two steps, so this adds to what is there.
          mkdir -p "$STUB_DIR/uploaded"
          cp -r "$stage"/. "$STUB_DIR/uploaded/"
          ;;
        delete) echo "delete" >>"$STUB_DIR/retention" ;;
        rmdirs) ;;
      esac
      exit 0
      ;;
    alpine:*)
      valid_archive
      exit 0
      ;;
  esac
done
EOF
chmod +x "$work/bin/docker"
mkdir -p "$work/stubdata"
echo data >"$work/stubdata/file"
export PATH="$work/bin:$PATH"
[ "$(command -v docker)" = "$work/bin/docker" ] || { echo "The docker stub is not first on PATH." >&2; exit 1; }

export STUB_DIR="$work"
export ENV_FILE="$work/env"
export RCLONE_CONFIG_DIR="$work/rclone"
export BACKUP_REMOTE="crypt-test:"
export BACKUP_STAGING_DIR="$work/staging"
cat >"$ENV_FILE" <<'EOF'
POSTGRES_USER=plane
EOF

status=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; status=1; }

reset() { rm -rf "$work/uploaded" "$work/retention" "$work/runner-command" "$work/calls"; }
run() { "$script" >"$work/out" 2>&1; }

reset
if run && [ -f "$work/uploaded/agent_workspaces.tar.gz" ] && grep -q agent_workspaces "$work/uploaded/SHA256SUMS" && [ -f "$work/retention" ]; then
  pass "a normal archive is uploaded and retention runs"
else
  fail "the normal backup did not complete: $(cat "$work/out")"
fi
if grep -q -- '--sparse' "$work/runner-command"; then
  pass "the workspace archive uses tar --sparse"
else
  fail "the workspace archive does not use tar --sparse"
fi

reset
if BACKUP_WORKSPACES_MAX_BYTES=1024 STUB_RUNNER_BYTES=1048576 run; then
  fail "an oversized archive did not fail the run"
elif [ -e "$work/uploaded/agent_workspaces.tar.gz" ] || grep -q agent_workspaces "$work/uploaded/SHA256SUMS" 2>/dev/null; then
  fail "the oversized archive was uploaded"
elif [ -f "$work/uploaded/postgres.dump" ] && [ -f "$work/uploaded/uploads.tar.gz" ] \
  && (cd "$work/uploaded" && sha256sum -c SHA256SUMS >/dev/null); then
  pass "an oversized archive is left out, and the database and uploads are still backed up"
else
  fail "the rest of the backup was not uploaded: $(cat "$work/out")"
fi
if [ -e "$work/retention" ]; then
  fail "retention ran after a partial backup"
else
  pass "retention is skipped when the workspaces were left out"
fi
if grep -q 'BACKUP_WORKSPACES_MAX_BYTES' "$work/out"; then
  pass "the error names the limit"
else
  fail "the error does not name the limit"
fi
if [ -s "$work/uploaded/WORKSPACES_OMITTED" ] && grep -q WORKSPACES_OMITTED "$work/uploaded/SHA256SUMS"; then
  pass "an oversized archive leaves a checksummed marker in the backup"
else
  fail "the WORKSPACES_OMITTED marker was not uploaded"
fi

listed() { awk '{ print $2 }' "$work/uploaded/SHA256SUMS" | sort | tr '\n' ' '; }

reset
if BACKUP_EXTRA_PATHS="$work/stubdata" run \
  && [ "$(listed)" = "agent_workspaces.tar.gz env extra.tar.gz postgres.dump uploads.tar.gz " ] \
  && [ ! -e "$work/uploaded/WORKSPACES_OMITTED" ] \
  && (cd "$work/uploaded" && sha256sum -c SHA256SUMS >/dev/null); then
  pass "the checksums cover the workspaces archive and the extra paths, with no marker"
else
  fail "the checksums are wrong for a normal backup with extra paths: $(listed) $(cat "$work/out")"
fi

reset
if BACKUP_EXTRA_PATHS="$work/stubdata" BACKUP_WORKSPACES_MAX_BYTES=1024 STUB_RUNNER_BYTES=1048576 run; then
  fail "an oversized archive with extra paths did not fail the run"
elif [ "$(listed)" = "WORKSPACES_OMITTED env extra.tar.gz postgres.dump uploads.tar.gz " ] \
  && (cd "$work/uploaded" && sha256sum -c SHA256SUMS >/dev/null); then
  pass "the checksums cover the marker and the extra paths when the workspaces are left out"
else
  fail "the checksums are wrong for an oversized backup with extra paths: $(listed) $(cat "$work/out")"
fi

reset
if STUB_RUNNER_STATUS=2 run; then
  fail "a failed workspace archive did not fail the run"
elif [ -e "$work/uploaded" ]; then
  fail "a backup was uploaded after the workspace archive failed"
else
  pass "a genuine archive failure stops the backup"
fi

exit "$status"
