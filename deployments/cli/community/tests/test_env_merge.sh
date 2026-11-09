#!/usr/bin/env bash
#
# Checks how install.sh and swarm.sh carry plane.env values across an upgrade.
# The real functions are extracted from each script and run against fixture files.
#
# Usage: ./test_env_merge.sh
# PLANE_INSTALL_SH and PLANE_SWARM_SH point the test at other copies of the scripts.

# The fixtures hold literal shell syntax, and the extracted functions read these variables.
# shellcheck disable=SC2016,SC2034,SC2329

TESTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_SH=${PLANE_INSTALL_SH:-$TESTS_DIR/../install.sh}
SWARM_SH=${PLANE_SWARM_SH:-$TESTS_DIR/../../../swarm/community/swarm.sh}
VARIABLES_ENV=$TESTS_DIR/../variables.env

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

passed=0
failed=0

pass() {
    passed=$((passed + 1))
}

fail() {
    failed=$((failed + 1))
    echo "FAIL [$CURRENT_SCRIPT] $1"
    [ -n "${2:-}" ] && printf '%s\n' "$2"
}

assert_equal() {
    if [ "$2" == "$3" ]; then
        pass
    else
        fail "$1" "  expected: [$2]
  actual:   [$3]"
    fi
}

assert_file_line() {
    if grep -qxF -- "$3" "$2"; then
        pass
    else
        fail "$1" "  missing line: [$3]
  in file:
$(sed 's/^/    /' "$2")"
    fi
}

assert_no_file_line() {
    if grep -qxF -- "$3" "$2"; then
        fail "$1" "  unexpected line: [$3]"
    else
        pass
    fi
}

# Prints the definitions of the named functions from a script without running it.
extract_functions() {
    local script=$1
    shift
    local name
    for name in "$@"; do
        sed -n "/^function $name *() *{/,/^}/p" "$script"
    done
}

# Call this inside a subshell, so an `exit` in the scripts cannot end the test run.
load_script() {
    local functions=$WORK_DIR/functions.sh
    extract_functions "$CURRENT_SCRIPT_PATH" getEnvValue rewriteEnvFile updateEnvFile updateCustomVariables syncEnvFile > "$functions"
    # shellcheck source=/dev/null
    source "$functions"
    PLANE_INSTALL_DIR=$CASE_DIR
    DOCKER_ENV_PATH=$CASE_DIR/plane.env
    DOCKERHUB_USER=makeplane
    APP_RELEASE=v9.9.9
    PULL_POLICY=if_not_present
    CUSTOM_BUILD=false
}

new_case() {
    CASE_DIR=$WORK_DIR/case
    rm -rf "$CASE_DIR"
    mkdir -p "$CASE_DIR"
}

# Keys and values that must come through an upgrade unchanged.
write_saved_env() {
    cat > "$CASE_DIR/plane.env.bak" <<'EOF'
# a comment that only the old file has
SECRET_KEY=ab&cd=ef/gh\ij|kl=
DATABASE_URL=postgresql://user:p%40ss@db:5432/plane?sslmode=require&x=1
EMPTY_IN_OLD=
EMPTY_IN_BOTH=
QUOTED="value with spaces & = signs"
DOLLARS=$HOME/`id`/$(id)
BACKSLASHES=\1\n\\t
HASH=before#after
LEADING_DASH=-n
NUMERIC=007
EXPONENT=1e3
#COMMENTED_OUT=from-a-comment
OLD_ONLY=not-in-the-template
DUPLICATED=first
DUPLICATED=last
STACK_NAME=my-stack
EOF
    # Written here so editors cannot strip the trailing space from the fixture.
    printf 'TRAILING_SPACE=kept \n' >> "$CASE_DIR/plane.env.bak"
}

write_template_env() {
    cat > "$CASE_DIR/plane.env" <<'EOF'
# Template header
# SECRET_KEY=this-comment-looks-like-an-assignment

SECRET_KEY=template-secret
DATABASE_URL=
EMPTY_IN_OLD=template-default
EMPTY_IN_BOTH=
QUOTED=template
DOLLARS=template
BACKSLASHES=template
HASH=template
LEADING_DASH=template
NUMERIC=1
EXPONENT=1
TRAILING_SPACE=template
COMMENTED_OUT=template-keeps-this
NEW_KEY=new=default&value
LINE_WITHOUT_SEPARATOR
DUPLICATED=template
APP_RELEASE=stable
DOCKERHUB_USER=template
PULL_POLICY=template
CUSTOM_BUILD=template
EOF
}

test_sync_preserves_values() {
    new_case
    write_saved_env
    write_template_env
    (
        load_script
        syncEnvFile
    ) > /dev/null 2>&1
    local env=$CASE_DIR/plane.env

    assert_file_line "value with = & / \\ | survives" "$env" 'SECRET_KEY=ab&cd=ef/gh\ij|kl='
    assert_file_line "URL with further = signs survives" "$env" 'DATABASE_URL=postgresql://user:p%40ss@db:5432/plane?sslmode=require&x=1'
    assert_file_line "empty value replaces the template default" "$env" 'EMPTY_IN_OLD='
    assert_no_file_line "template default is not used for an empty value" "$env" 'EMPTY_IN_OLD=template-default'
    assert_file_line "key empty in both stays empty" "$env" 'EMPTY_IN_BOTH='
    assert_file_line "quotes survive" "$env" 'QUOTED="value with spaces & = signs"'
    assert_file_line "shell syntax is not expanded" "$env" 'DOLLARS=$HOME/`id`/$(id)'
    assert_file_line "backslash sequences survive" "$env" 'BACKSLASHES=\1\n\\t'
    assert_file_line "hash inside a value survives" "$env" 'HASH=before#after'
    assert_file_line "value that looks like an echo flag survives" "$env" 'LEADING_DASH=-n'
    assert_file_line "number-like value keeps its text" "$env" 'NUMERIC=007'
    assert_file_line "exponent-like value keeps its text" "$env" 'EXPONENT=1e3'
    assert_file_line "trailing space survives" "$env" 'TRAILING_SPACE=kept '
    assert_file_line "a repeated key takes its last value" "$env" 'DUPLICATED=last'
    assert_file_line "commented-out old key is not a value" "$env" 'COMMENTED_OUT=template-keeps-this'
    assert_file_line "template comment stays" "$env" '# Template header'
    assert_file_line "template comment that looks like a key stays" "$env" '# SECRET_KEY=this-comment-looks-like-an-assignment'
    assert_file_line "new template key keeps its default" "$env" 'NEW_KEY=new=default&value'
    assert_file_line "line without a separator stays" "$env" 'LINE_WITHOUT_SEPARATOR'
    assert_no_file_line "keys only in the old file are not merged" "$env" 'OLD_ONLY=not-in-the-template'
    assert_no_file_line "comments only in the old file are not merged" "$env" '# a comment that only the old file has'
}

test_sync_keeps_shape_of_template() {
    new_case
    cp "$VARIABLES_ENV" "$CASE_DIR/plane.env"
    cp "$VARIABLES_ENV" "$CASE_DIR/plane.env.bak"
    (
        load_script
        # updateCustomVariables only writes values the saved file overwrites.
        updateCustomVariables() { :; }
        syncEnvFile
    ) > /dev/null 2>&1
    if cmp -s "$VARIABLES_ENV" "$CASE_DIR/plane.env"; then
        pass
    else
        fail "merging the shipped template with itself changes it" "$(diff "$VARIABLES_ENV" "$CASE_DIR/plane.env" | head -20)"
    fi
}

test_get_env_value() {
    new_case
    cat > "$CASE_DIR/env" <<'EOF'
PLAIN=value
FURTHER=a=b==c=
EMPTY=
FOOBAR=not-foo
#HIDDEN=comment
A.B=dot
AxB=regex-match
EOF
    local result
    result=$(
        load_script
        printf '%s|' "$(getEnvValue PLAIN "$CASE_DIR/env")" \
            "$(getEnvValue FURTHER "$CASE_DIR/env")" \
            "$(getEnvValue EMPTY "$CASE_DIR/env")" \
            "$(getEnvValue MISSING "$CASE_DIR/env")" \
            "$(getEnvValue FOO "$CASE_DIR/env")" \
            "$(getEnvValue HIDDEN "$CASE_DIR/env")" \
            "$(getEnvValue A.B "$CASE_DIR/env")"
    )
    assert_equal "getEnvValue results" 'value|a=b==c=|||||dot|' "$result"
}

test_update_env_file() {
    new_case
    printf 'KEEP=me\nSECRET_KEY=old-value\n# SECRET_KEY=comment\n' > "$CASE_DIR/env"
    (
        load_script
        updateEnvFile SECRET_KEY 'ab&cd=e/f\g|h' "$CASE_DIR/env"
        updateEnvFile NEW_KEY 'x&y=z' "$CASE_DIR/env"
    ) > /dev/null 2>&1
    assert_file_line "updateEnvFile writes the value verbatim" "$CASE_DIR/env" 'SECRET_KEY=ab&cd=e/f\g|h'
    assert_file_line "updateEnvFile leaves comments alone" "$CASE_DIR/env" '# SECRET_KEY=comment'
    assert_file_line "updateEnvFile leaves other keys alone" "$CASE_DIR/env" 'KEEP=me'
    assert_file_line "updateEnvFile appends a missing key" "$CASE_DIR/env" 'NEW_KEY=x&y=z'

    printf 'LAST=no-trailing-newline' > "$CASE_DIR/env"
    (
        load_script
        updateEnvFile APPENDED value "$CASE_DIR/env"
    ) > /dev/null 2>&1
    assert_file_line "a file without a final newline keeps its last line" "$CASE_DIR/env" 'LAST=no-trailing-newline'
    assert_file_line "a key is appended on its own line" "$CASE_DIR/env" 'APPENDED=value'

    printf 'SECRET_KEY=old\n' > "$CASE_DIR/env"
    chmod 600 "$CASE_DIR/env"
    (
        load_script
        updateEnvFile SECRET_KEY new "$CASE_DIR/env"
    ) > /dev/null 2>&1
    assert_equal "permissions are kept" "600" "$(stat -c '%a' "$CASE_DIR/env" 2> /dev/null || stat -f '%Lp' "$CASE_DIR/env")"
    if [ -e "$CASE_DIR/env.tmp" ]; then
        fail "temporary file left behind"
    else
        pass
    fi

    local output status
    output=$(
        load_script
        updateEnvFile KEY "" "$CASE_DIR/env"
    )
    status=$?
    assert_equal "updateEnvFile still rejects an empty value" "1:Invalid arguments supplied" "$status:$output"
}

test_install_custom_variables() {
    new_case
    write_template_env
    printf 'APP_RELEASE=v1.0.0\nDOCKERHUB_USER=custom/user\n' > "$CASE_DIR/plane.env.bak"
    (
        load_script
        syncEnvFile
    ) > /dev/null 2>&1
    assert_file_line "saved registry user is merged" "$CASE_DIR/plane.env" 'DOCKERHUB_USER=custom/user'
    assert_file_line "custom variables are written" "$CASE_DIR/plane.env" 'PULL_POLICY=if_not_present'
}

test_swarm_stack_name() {
    new_case
    write_saved_env
    write_template_env
    (
        load_script
        syncEnvFile
    ) > /dev/null 2>&1
    assert_file_line "stack name is carried over" "$CASE_DIR/plane.env" 'STACK_NAME=my-stack'
    if [ -e "$CASE_DIR/plane.env.bak" ]; then
        fail "plane.env.bak is removed after the merge"
    else
        pass
    fi
}

for target in "install:$INSTALL_SH" "swarm:$SWARM_SH"; do
    CURRENT_SCRIPT=${target%%:*}
    CURRENT_SCRIPT_PATH=${target#*:}
    test_sync_preserves_values
    test_sync_keeps_shape_of_template
    test_get_env_value
    test_update_env_file
    if [ "$CURRENT_SCRIPT" == "install" ]; then
        test_install_custom_variables
    else
        test_swarm_stack_name
    fi
done

echo "env merge: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
