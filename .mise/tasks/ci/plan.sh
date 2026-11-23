#!/usr/bin/env bash
#MISE description="Select the CI lanes a change needs: --base <sha> --head <sha>, or --full"
set -euo pipefail
exec node tools/ci/plan.ts "$@"
