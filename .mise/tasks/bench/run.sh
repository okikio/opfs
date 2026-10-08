#!/usr/bin/env bash
#MISE description="Check discovered benchmarks; optional files and --shard"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/bench/run.ts "$@"
