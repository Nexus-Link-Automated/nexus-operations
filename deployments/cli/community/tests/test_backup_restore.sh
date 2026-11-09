#!/usr/bin/env bash
#
# Runs the real `setup.sh backup` and restore.sh against a throwaway Postgres container.
#
# A docker wrapper placed first on PATH maps the plane-app volume names onto a
# unique prefix, so the volumes of an installed Plane are never touched. Everything
# created here carries that prefix and is removed on exit.
#
# Usage: ./test_backup_restore.sh
# PLANE_INSTALL_SH and PLANE_RESTORE_SH point the test at other copies of the scripts.

TESTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_SH=${PLANE_INSTALL_SH:-$TESTS_DIR/../install.sh}
RESTORE_SH=${PLANE_RESTORE_SH:-$TESTS_DIR/../restore.sh}

for tool in docker jq; do
    if ! command -v "$tool" > /dev/null; then
        echo "SKIP: $tool is not installed"
        exit 0
    fi
done
if ! docker info > /dev/null 2>&1; then
    echo "SKIP: the docker daemon is not reachable"
    exit 0
fi

REAL_DOCKER=$(command -v docker)
PG_IMAGE=$(sed -n 's/^ *image: *\(postgres:[^ ]*\)$/\1/p' "$TESTS_DIR/../docker-compose.yml" | head -n 1)
BUSYBOX_IMAGE=busybox

TEST_PROJECT=planebackuptest$$x$RANDOM
DB_CONTAINER=$TEST_PROJECT-db
VERIFY_CONTAINER=$TEST_PROJECT-verify
DB_VOLUME=$TEST_PROJECT-dbsource
VOLUME_NAMES="pgdata rabbitmq_data redisdata uploads"

WORK_DIR=$(mktemp -d)
BIN_DIR=$WORK_DIR/bin
INSTALL_DIR=$WORK_DIR/install
SCENARIOS_DIR=$WORK_DIR/scenarios
LOG_FILE=$WORK_DIR/script.log
WRITER_PID=""
IMAGES_TO_REMOVE=()

passed=0
failed=0

pass() {
    passed=$((passed + 1))
}

fail() {
    failed=$((failed + 1))
    echo "FAIL $1"
    if [ -n "${2:-}" ]; then
        printf '%s\n' "$2" | sed 's/^/    /'
    fi
}

check() {
    local description=$1
    shift
    if "$@"; then
        pass
    else
        fail "$description" "$(tail -n 15 "$LOG_FILE" 2> /dev/null)"
    fi
}

assert_equal() {
    if [ "$2" == "$3" ]; then
        pass
    else
        fail "$1" "expected: [$2]
actual:   [$3]"
    fi
}

log_contains() {
    grep -qF -- "$1" "$LOG_FILE"
}

log_lacks() {
    ! grep -qF -- "$1" "$LOG_FILE"
}

stop_writer() {
    if [ -n "$WRITER_PID" ]; then
        kill "$WRITER_PID" 2> /dev/null
        wait "$WRITER_PID" 2> /dev/null
        WRITER_PID=""
    fi
}

cleanup() {
    stop_writer
    local name
    for name in $("$REAL_DOCKER" ps -aq --filter "name=^/$TEST_PROJECT-"); do
        "$REAL_DOCKER" rm -f -v "$name" > /dev/null 2>&1
    done
    for name in $("$REAL_DOCKER" volume ls -q --filter "name=$TEST_PROJECT" | grep "^$TEST_PROJECT"); do
        "$REAL_DOCKER" volume rm -f "$name" > /dev/null 2>&1
    done
    for name in "${IMAGES_TO_REMOVE[@]}"; do
        "$REAL_DOCKER" rmi "$name" > /dev/null 2>&1
    done
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

write_wrappers() {
    mkdir -p "$BIN_DIR"
    cat > "$BIN_DIR/docker" <<'WRAPPER'
#!/usr/bin/env bash
args=()
for arg in "$@"; do
    arg=${arg//plane-app_/${TEST_PROJECT}_}
    arg=${arg/name=plane-app/name=$TEST_PROJECT}
    args+=("$arg")
done
set -- "${args[@]}"

case "$1" in
    compose)
        case " $* " in
            *" ls "*) echo '[]' ;;
            *" ps "*) "$REAL_DOCKER" inspect --format '{{.Id}}' "$TEST_DB_CONTAINER" ;;
        esac
        exit 0
        ;;
    run)
        shift
        exec "$REAL_DOCKER" run --security-opt label=disable "$@"
        ;;
    stop)
        if [ -n "${TEST_KILL_ON_STOP:-}" ]; then
            exec "$REAL_DOCKER" kill "${@: -1}"
        fi
        ;;
    cp)
        if [ -n "${TEST_FAIL_CP:-}" ]; then
            exit 1
        fi
        ;;
    volume)
        if [ "$2" == "rm" ] && [ -n "${TEST_FAIL_VOLUME_RM:-}" ]; then
            exit 1
        fi
        ;;
esac
exec "$REAL_DOCKER" "$@"
WRAPPER
    printf '#!/usr/bin/env bash\nexec docker compose "$@"\n' > "$BIN_DIR/docker-compose"
    printf '#!/usr/bin/env bash\n' > "$BIN_DIR/clear"
    chmod +x "$BIN_DIR/docker" "$BIN_DIR/docker-compose" "$BIN_DIR/clear"
    export REAL_DOCKER TEST_PROJECT
    export TEST_DB_CONTAINER=$DB_CONTAINER
}

wait_for_postgres() {
    local _
    for _ in $(seq 1 60); do
        if "$REAL_DOCKER" exec "$1" pg_isready -q -h 127.0.0.1 > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

query() {
    "$REAL_DOCKER" exec "$1" psql -U plane -d plane -Atc "$2"
}

start_source_database() {
    "$REAL_DOCKER" run -d --name "$DB_CONTAINER" --network none \
        -e POSTGRES_USER=plane -e POSTGRES_PASSWORD=test-only -e POSTGRES_DB=plane \
        -v "$DB_VOLUME:/var/lib/postgresql/data" "$PG_IMAGE" > /dev/null || return 1
    wait_for_postgres "$DB_CONTAINER" || return 1

    query "$DB_CONTAINER" "
        CREATE TABLE notes(id int PRIMARY KEY, body text);
        INSERT INTO notes VALUES (1, 'backed-up row');
        CREATE TABLE ledger_a(amount int);
        CREATE TABLE ledger_b(amount int);
        INSERT INTO ledger_a VALUES (0);
        INSERT INTO ledger_b VALUES (0);
    " > /dev/null || return 1

    # The other services' data lives in the same container for this test.
    "$REAL_DOCKER" exec "$DB_CONTAINER" sh -c '
        mkdir -p /export/bucket /var/lib/rabbitmq /data
        echo object > /export/bucket/object.txt
        echo settings > /export/.minio.sys
        echo queue > /var/lib/rabbitmq/queue.dat
        echo cookie > /var/lib/rabbitmq/.erlang.cookie
    '
}

# Keeps committing paired updates so the backup runs against an active database.
start_writer() {
    (
        while :; do
            "$REAL_DOCKER" exec "$DB_CONTAINER" psql -U plane -d plane -q \
                -c "UPDATE ledger_a SET amount = amount + 1; UPDATE ledger_b SET amount = amount + 1;" > /dev/null 2>&1 \
                || sleep 0.2
        done
    ) &
    WRITER_PID=$!
}

run_backup() {
    rm -rf "$INSTALL_DIR/plane-app/backup"
    (
        cd "$INSTALL_DIR" || exit 1
        PATH="$BIN_DIR:$PATH" bash "$INSTALL_SH" backup
    ) > "$LOG_FILE" 2>&1
}

run_restore() {
    (
        cd "$INSTALL_DIR" || exit 1
        PATH="$BIN_DIR:$PATH" bash "$RESTORE_SH" "$1"
    ) > "$LOG_FILE" 2>&1
}

latest_backup() {
    ls -d "$INSTALL_DIR"/plane-app/backup/*/ 2> /dev/null | tail -n 1 | sed 's:/$::'
}

in_volume() {
    local volume=$1
    shift
    "$REAL_DOCKER" run --rm --security-opt label=disable -v "$volume:/vol" "$BUSYBOX_IMAGE" "$@"
}

reset_target_volumes() {
    local name
    "$REAL_DOCKER" rm -f -v "$VERIFY_CONTAINER" > /dev/null 2>&1
    for name in $VOLUME_NAMES; do
        "$REAL_DOCKER" volume rm -f "${TEST_PROJECT}_$name" > /dev/null 2>&1
        "$REAL_DOCKER" volume create "${TEST_PROJECT}_$name" > /dev/null
        in_volume "${TEST_PROJECT}_$name" sh -c 'echo existing > /vol/marker'
    done
}

targets_untouched() {
    local name
    for name in $VOLUME_NAMES; do
        [ "$(in_volume "${TEST_PROJECT}_$name" cat /vol/marker 2> /dev/null)" == "existing" ] || return 1
    done
}

scenario_copy() {
    local copy=$SCENARIOS_DIR/$1
    rm -rf "$copy"
    mkdir -p "$copy"
    cp "$BACKUP_DIR"/*.tar.gz "$copy/"
    echo "$copy"
}

# A bad archive must stop the restore while every volume still holds its old data.
expect_rejected() {
    local description=$1
    local folder=$2

    reset_target_volumes
    run_restore "$folder"
    local status=$?
    check "$description: exits non-zero" [ "$status" -ne 0 ]
    check "$description: does not report success" log_lacks "Restore completed successfully"
    check "$description: leaves every volume as it was" targets_untouched
}

verify_restored_database() {
    local description=$1

    "$REAL_DOCKER" run -d --name "$VERIFY_CONTAINER" --network none \
        -e POSTGRES_PASSWORD=ignored \
        -v "${TEST_PROJECT}_pgdata:/var/lib/postgresql/data" "$PG_IMAGE" > /dev/null
    if ! wait_for_postgres "$VERIFY_CONTAINER"; then
        fail "$description: restored database starts" "$("$REAL_DOCKER" logs --tail 15 "$VERIFY_CONTAINER" 2>&1)"
        "$REAL_DOCKER" rm -f -v "$VERIFY_CONTAINER" > /dev/null 2>&1
        return
    fi
    assert_equal "$description: restored row" "backed-up row" "$(query "$VERIFY_CONTAINER" 'SELECT body FROM notes WHERE id = 1')"
    assert_equal "$description: paired updates match" "t" \
        "$(query "$VERIFY_CONTAINER" 'SELECT a.amount = b.amount FROM ledger_a a, ledger_b b')"
    "$REAL_DOCKER" rm -f -v "$VERIFY_CONTAINER" > /dev/null 2>&1
}

test_backup_is_consistent() {
    start_writer
    sleep 2
    run_backup
    local status=$?
    stop_writer

    check "backup exits zero" [ "$status" -eq 0 ]
    check "backup reports success" log_contains "Backup completed successfully"
    BACKUP_DIR=$(latest_backup)

    local name
    for name in $VOLUME_NAMES; do
        check "backup writes $name.tar.gz" [ -f "$BACKUP_DIR/$name.tar.gz" ]
    done

    local state
    state=$("$REAL_DOCKER" run --rm --security-opt label=disable --entrypoint sh \
        -v "$BACKUP_DIR:/backup:ro" "$PG_IMAGE" -c '
            mkdir /tmp/x && tar -xzf /backup/pgdata.tar.gz -C /tmp/x
            [ -e /tmp/x/pgdata/postmaster.pid ] && echo live-server-pid
            pg_controldata /tmp/x/pgdata | sed -n "s/^Database cluster state: *//p"
        ')
    assert_equal "archived cluster was cleanly shut down" "shut down" "$state"

    check "database is serving again after the backup" wait_for_postgres "$DB_CONTAINER"
    assert_equal "database accepts writes after the backup" "1" \
        "$(query "$DB_CONTAINER" 'UPDATE notes SET body = body WHERE id = 1 RETURNING id' | head -n 1)"
}

test_failed_copy_restarts_database() {
    TEST_FAIL_CP=1 run_backup
    local status=$?
    check "failed copy: backup exits non-zero" [ "$status" -ne 0 ]
    check "failed copy: does not report success" log_lacks "Backup completed successfully"
    check "failed copy: database is serving again" wait_for_postgres "$DB_CONTAINER"
}

test_unclean_stop_aborts_backup() {
    TEST_KILL_ON_STOP=1 run_backup
    local status=$?
    check "unclean stop: backup exits non-zero" [ "$status" -ne 0 ]
    check "unclean stop: reports the reason" log_contains "did not shut down cleanly"
    check "unclean stop: writes no database archive" [ ! -e "$(latest_backup)/pgdata.tar.gz" ]
    check "unclean stop: database is serving again" wait_for_postgres "$DB_CONTAINER"
}

test_restore_of_new_backup() {
    reset_target_volumes
    run_restore "$BACKUP_DIR"
    local status=$?
    check "restore exits zero" [ "$status" -eq 0 ]
    check "restore reports success" log_contains "Restore completed successfully"
    verify_restored_database "restore"

    assert_equal "old volume contents are replaced" "gone" \
        "$(in_volume "${TEST_PROJECT}_uploads" sh -c '[ -e /vol/marker ] && echo there || echo gone')"
    assert_equal "uploads are restored" "object" "$(in_volume "${TEST_PROJECT}_uploads" cat /vol/bucket/object.txt)"
    assert_equal "dotfiles in uploads are restored" "settings" "$(in_volume "${TEST_PROJECT}_uploads" cat /vol/.minio.sys)"
    assert_equal "rabbitmq dotfiles are restored" "cookie" "$(in_volume "${TEST_PROJECT}_rabbitmq_data" cat /vol/.erlang.cookie)"
    assert_equal "an empty volume is restored as empty" "" "$(in_volume "${TEST_PROJECT}_redisdata" ls -A /vol)"
}

test_restore_of_old_style_backup() {
    # The previous backup copied the data directory of the running server.
    local folder
    folder=$(scenario_copy old-style)
    rm "$folder/pgdata.tar.gz"
    mkdir "$folder/pgdata"
    "$REAL_DOCKER" cp -q "$DB_CONTAINER:/var/lib/postgresql/data/." "$folder/pgdata/"
    tar -czf "$folder/pgdata.tar.gz" -C "$folder" pgdata
    rm -rf "$folder/pgdata"

    reset_target_volumes
    run_restore "$folder"
    local status=$?
    check "old-style backup: restore exits zero" [ "$status" -eq 0 ]
    verify_restored_database "old-style backup"
}

test_relative_path() {
    reset_target_volumes
    run_restore "plane-app/backup/$(basename "$BACKUP_DIR")"
    local status=$?
    check "relative path: restore exits zero" [ "$status" -eq 0 ]
    verify_restored_database "relative path"
}

test_bad_archives_are_rejected() {
    local folder size

    # Archives restore in name order, so a damaged last archive proves the check runs first.
    folder=$(scenario_copy truncated)
    size=$(wc -c < "$folder/uploads.tar.gz")
    head -c $((size / 2)) "$BACKUP_DIR/uploads.tar.gz" > "$folder/uploads.tar.gz"
    expect_rejected "truncated archive" "$folder"

    folder=$(scenario_copy corrupted)
    size=$(wc -c < "$folder/uploads.tar.gz")
    printf '\377\000\377\000' | dd of="$folder/uploads.tar.gz" bs=1 seek=$((size / 2)) conv=notrunc 2> /dev/null
    expect_rejected "corrupted archive" "$folder"

    folder=$(scenario_copy not-gzip)
    echo "this is not an archive" > "$folder/uploads.tar.gz"
    expect_rejected "file that is not gzip" "$folder"

    folder=$(scenario_copy wrong-layout)
    mkdir "$folder/elsewhere"
    echo data > "$folder/elsewhere/file"
    tar -czf "$folder/uploads.tar.gz" -C "$folder" elsewhere
    rm -rf "$folder/elsewhere"
    expect_rejected "archive with the wrong top directory" "$folder"

    folder=$(scenario_copy not-a-cluster)
    mkdir "$folder/pgdata"
    echo data > "$folder/pgdata/file"
    tar -czf "$folder/pgdata.tar.gz" -C "$folder" pgdata
    rm -rf "$folder/pgdata"
    expect_rejected "database archive without a cluster" "$folder"

    reset_target_volumes
    run_restore "$WORK_DIR/does-not-exist"
    local status=$?
    check "missing folder: exits non-zero" [ "$status" -ne 0 ]
    check "missing folder: leaves every volume as it was" targets_untouched
}

test_failure_while_restoring_is_reported() {
    reset_target_volumes
    TEST_FAIL_VOLUME_RM=1 run_restore "$BACKUP_DIR"
    local status=$?
    check "volume in use: restore exits non-zero" [ "$status" -ne 0 ]
    check "volume in use: does not report success" log_lacks "Restore completed successfully"
    check "volume in use: leaves every volume as it was" targets_untouched
}

for image in "$PG_IMAGE" "$BUSYBOX_IMAGE"; do
    if ! "$REAL_DOCKER" image inspect "$image" > /dev/null 2>&1; then
        IMAGES_TO_REMOVE+=("$image")
    fi
done

write_wrappers
mkdir -p "$INSTALL_DIR/plane-app" "$SCENARIOS_DIR"
touch "$INSTALL_DIR/plane-app/docker-compose.yaml"

if ! start_source_database; then
    echo "FAIL could not start the throwaway database"
    exit 1
fi

test_backup_is_consistent
test_failed_copy_restarts_database
test_unclean_stop_aborts_backup
# Failed backups above share this folder name; take a good backup again before restoring.
run_backup
BACKUP_DIR=$(latest_backup)
test_restore_of_new_backup
test_restore_of_old_style_backup
test_relative_path
test_bad_archives_are_rejected
test_failure_while_restoring_is_reported

echo "backup and restore: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
