#!/usr/bin/env bash
# List your pods with status and hourly cost.
source "$(dirname "$0")/api.sh"
runpod GET /pods | jq -r '["ID","NAME","STATUS","GPUS","$/HR"], (.[] | [.id, .name, .desiredStatus, .gpuCount, .costPerHr]) | @tsv' | column -t -s $'\t'
