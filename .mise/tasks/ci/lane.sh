#!/usr/bin/env bash
#MISE description="Run one CI lane with the same tasks as a local run: <lane> [--runtime] [--shard] [--kind]"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/ci/lane.ts "$@"
