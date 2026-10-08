#!/usr/bin/env bash
#MISE description="Run a GitHub Actions workflow locally with act"
#MISE depends=[]
# Example: mise run actions .github/workflows/ci.yml --event workflow_dispatch
# The first argument is the workflow file. `--event <name>` selects the event
# (act's default is push); every other argument goes to act unchanged.
# act needs a running Docker daemon. act is a lazy tool in mise.toml, installed on first use.
set -euo pipefail
workflow=${1:?Name a workflow file, for example .github/workflows/ci.yml}
shift
event=push
args=()
while (($#)); do
  case $1 in
    --event) event=${2:?--event needs an event name}; shift 2 ;;
    --event=*) event=${1#--event=}; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
exec act "$event" --workflows "$workflow" "${args[@]}"
