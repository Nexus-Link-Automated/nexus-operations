#!/usr/bin/env bash

function print_header() {
clear

cat <<"EOF"
--------------------------------------------
 ____  _                          ///////// 
|  _ \| | __ _ _ __   ___         ///////// 
| |_) | |/ _` | '_ \ / _ \   /////    ///// 
|  __/| | (_| | | | |  __/   /////    ///// 
|_|   |_|\__,_|_| |_|\___|        ////      
                                  ////      
--------------------------------------------
Project management tool from the future
--------------------------------------------
EOF
}

# Reads the whole archive and checks its layout, so a damaged file is caught
# while the volumes are still intact.
function validateArchive() {
    local backupFolder=$1
    local restoreFile=$2

    docker run --rm \
        -e TAR_NAME="$restoreFile" \
        -v "$backupFolder":/backup:ro \
        busybox sh -c '
            gzip -t "/backup/${TAR_NAME}.tar.gz" &&
            tar -tzf "/backup/${TAR_NAME}.tar.gz" > /tmp/contents &&
            grep -q "^${TAR_NAME}/" /tmp/contents &&
            { [ "$TAR_NAME" != "pgdata" ] || grep -q "^pgdata/PG_VERSION$" /tmp/contents; }
        '
}

function restoreSingleVolume() {
    selectedVolume=$1
    backupFolder=$2
    restoreFile=$3

    docker volume rm "$selectedVolume" > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        echo "Error: Failed to remove volume $selectedVolume"
        echo ""
        return 1
    fi

    docker volume create "$selectedVolume" > /dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo "Error: Failed to create volume $selectedVolume"
        echo ""
        return 1
    fi

    docker run --rm \
        -e TAR_NAME="$restoreFile" \
        -v "$selectedVolume":"/vol" \
        -v "$backupFolder":/backup \
        busybox sh -c 'mkdir -p /restore && tar -xzf "/backup/${TAR_NAME}.tar.gz" -C /restore && cp -a "/restore/${TAR_NAME}/." /vol/'
    
    if [ $? -ne 0 ]; then
        echo "Error: Failed to restore volume ${selectedVolume} from ${restoreFile}.tar.gz"
        echo ""
        return 1
    fi
    echo ".....Successfully restored volume $selectedVolume from ${restoreFile}.tar.gz"
    echo ""
}

function restoreData() {
    print_header
    local BACKUP_FOLDER=${1:-$PWD}
    # docker would read a relative path as a volume name
    BACKUP_FOLDER=$(cd "$BACKUP_FOLDER" && pwd) || exit 1

    local dockerServiceStatus
    dockerServiceStatus=$($COMPOSE_CMD ls --filter name=plane-app --format=json | jq -r .[0].Status)
    local dockerServicePrefix
    dockerServicePrefix="running"

    if [[ $dockerServiceStatus == $dockerServicePrefix* ]]; then
        echo "Plane App is running. Please STOP the Plane App before restoring data."
        exit 1
    fi

    local volume_suffix
    volume_suffix="_pgdata|_redisdata|_uploads|_rabbitmq_data"
    local volumes
    volumes=$(docker volume ls -f "name=plane-app" --format "{{.Name}}" | grep -E "$volume_suffix")
    # Check if there are any matching volumes
    if [ -z "$volumes" ]; then
        echo ".....No volumes found starting with 'plane-app'"
        exit 1
    fi
    

    # Every archive is validated before the first volume is touched
    local restoreVolumes=()
    local restoreFiles=()

    for BACKUP_FILE in "$BACKUP_FOLDER"/*.tar.gz; do
        if [ -e "$BACKUP_FILE" ]; then
            
            local restoreFileName
            restoreFileName=$(basename "$BACKUP_FILE")
            restoreFileName="${restoreFileName%.tar.gz}"

            local restoreVolName
            restoreVolName="plane-app_${restoreFileName}"
            echo "Found $BACKUP_FILE"

            local docVol
            docVol=$(docker volume ls -f "name=$restoreVolName" --format "{{.Name}}" | grep -E "$volume_suffix")

            if [ -z "$docVol" ]; then
                echo "Skipping: No volume found with name $restoreVolName"
            elif validateArchive "$BACKUP_FOLDER" "$restoreFileName"; then
                restoreVolumes+=("$docVol")
                restoreFiles+=("$restoreFileName")
            else
                echo "Error: ${restoreFileName}.tar.gz is not a valid backup archive. No volumes were changed."
                exit 1
            fi
        else
            echo "No .tar.gz files found in the current directory."
            echo ""
            echo "Please provide the path to the backup file."
            echo ""
            echo "Usage: ./restore.sh /path/to/backup"
            exit 1
        fi
    done

    local index
    for index in "${!restoreVolumes[@]}"; do
        echo ".....Restoring ${restoreVolumes[$index]}"
        if ! restoreSingleVolume "${restoreVolumes[$index]}" "$BACKUP_FOLDER" "${restoreFiles[$index]}"; then
            echo "Restore failed. Volumes restored before this error keep the backup's data."
            exit 1
        fi
    done

    echo ""
    echo "Restore completed successfully."
    echo ""
}

# if docker-compose is installed
if command -v docker-compose &> /dev/null
then
    COMPOSE_CMD="docker-compose"
else
    COMPOSE_CMD="docker compose"
fi

restoreData "$@"